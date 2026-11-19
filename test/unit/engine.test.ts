import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keypair } from '@synonymdev/pubky';
import { receiveMessages, v1Conversation, type MessageFetch } from '../../src/conversation';
import {
  createEngine,
  describeFetchFailure,
  outsideConversation,
  type EngineContext,
  type FetchConfig,
  type FetchFailure,
} from '../../src/engine';
import { PrivateMessage } from '../../src/message';
import {
  FakeStorage,
  directory,
  entriesOutside,
  keypair,
  settle,
  z32,
} from '../support/fake-storage';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function config(client: number, perConversation: number): Partial<FetchConfig> {
  return {
    maxConcurrentRequests: client,
    maxConcurrentRequestsPerConversation: perConversation,
    requestTimeoutMs: 5000,
    maxAttempts: 3,
    retryBaseDelayMs: 1000,
    maxRetryDelayMs: 10_000,
    listPageSize: 1000,
    maxListingEntries: 100_000,
  };
}

function engine(server: FakeStorage, reader: Keypair, cfg: Partial<FetchConfig>): EngineContext {
  return createEngine(server.storageFor(z32(reader)), cfg);
}

function conversation(reader: Keypair, other: Keypair) {
  return v1Conversation(reader.secret(), z32(reader), z32(other), other.publicKey.toUint8Array());
}

function receive(
  ctx: EngineContext,
  reader: Keypair,
  other: Keypair,
  signal?: AbortSignal,
): Promise<MessageFetch> {
  return settle(receiveMessages(ctx, conversation(reader, other), signal));
}

const contents = (fetch: MessageFetch): string[] => fetch.messages.map((m) => m.content);
const history = (prefix: string, count: number): Array<[number, string]> =>
  Array.from({ length: count }, (_, i) => [i, `${prefix} ${i}`]);

describe('request engine', () => {
  it('overlapping requests stay within client and conversation limits', async () => {
    const alice = keypair(1);
    const others = [10, 11, 12, 13].map(keypair);
    const server = new FakeStorage(100);
    for (const other of others) {
      server.publish(alice, other, history('from alice', 15));
      server.publish(other, alice, history('to alice', 15));
    }
    const ctx = engine(server, alice, config(6, 4));

    const fetches = await settle(
      Promise.all(others.map((other) => receiveMessages(ctx, conversation(alice, other)))),
    );

    for (const fetch of fetches) {
      expect(fetch.messages.length).toBe(30);
      expect(fetch.failures).toEqual([]);
    }
    expect(server.state.peak).toBe(6);
    expect(server.state.peakByConversation.size).toBe(4);
    const peaks = [...server.state.peakByConversation.values()];
    expect(peaks.every((p) => p <= 4)).toBe(true);
    expect(peaks.some((p) => p === 4)).toBe(true);
    expect(server.state.inFlight).toBe(0);
    expect(ctx.budget.available()).toBe(6);
  });

  it('equal timestamps keep listing order whatever completes first', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const urls = server.publish(alice, bob, [
      [10, 'a0'],
      [20, 'a1'],
      [10, 'a2'],
    ]);
    urls.push(
      ...server.publish(bob, alice, [
        [10, 'b0'],
        [5, 'b1'],
      ]),
    );
    // Later entries complete first
    urls.forEach((url, i) => server.delays.set(url, 100 * (urls.length - i)));

    const asAlice = await receive(engine(server, alice, config(16, 16)), alice, bob);
    const asBob = await receive(engine(server, bob, config(16, 16)), bob, alice);

    expect(contents(asAlice)).toEqual(['b1', 'a0', 'a2', 'b0', 'a1']);
    expect(contents(asBob)).toEqual(['b1', 'b0', 'a0', 'a2', 'a1']);
  });

  it('tampered signatures are reported unverified', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const urls = server.publish(alice, bob, [
      [1, 'intact'],
      [2, 'bad signature'],
      [3, 'moved'],
    ]);
    const tamper = (
      url: string,
      change: (m: ReturnType<PrivateMessage['toJSON']>) => void,
    ): void => {
      const message = PrivateMessage.deserialize(server.body(url)).toJSON();
      change(message);
      server.reply(url, [{ body: JSON.stringify(message) }]);
    };
    tamper(urls[1]!, (m) => (m.signature_bytes[0] = m.signature_bytes[0]! ^ 1));
    tamper(urls[2]!, (m) => (m.timestamp = 0));

    const fetch = await receive(engine(server, bob, config(4, 4)), bob, alice);

    expect(fetch.messages.map((m) => [m.content, m.verified])).toEqual([
      ['moved', false],
      ['intact', true],
      ['bad signature', false],
    ]);
  });

  it('timed out attempts release capacity and retry', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage(100);
    const urls = server.publish(alice, bob, [
      [1, 'slow once'],
      [2, 'never arrives'],
      [3, 'prompt'],
    ]);
    const slowOnce = server.body(urls[0]!);
    server.reply(urls[0]!, ['hang', { body: slowOnce }]);
    server.reply(urls[1]!, ['hang']);
    // A single permit: an attempt that kept it after timing out would stall everything else
    const ctx = engine(server, alice, config(1, 1));

    const fetch = await receive(ctx, alice, bob);

    expect(contents(fetch)).toEqual(['slow once', 'prompt']);
    expect(fetch.failures).toEqual([{ url: urls[1], attempts: 3, reason: { kind: 'timedOut' } }]);
    expect(server.attempts(urls[0]!)).toBe(2);
    expect(ctx.budget.available()).toBe(1);
    expect(server.state.inFlight).toBe(0);
    expect(ctx.metrics.snapshot().timeouts).toBe(4);
  });

  it('cancelling a receive releases capacity', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const carol = keypair(3);
    const server = new FakeStorage(100);
    server.publish(alice, bob, [[1, 'stuck']]);
    server.reply(directory(alice, bob), ['hang']);
    server.reply(directory(bob, alice), ['hang']);
    server.publish(alice, carol, [[1, 'hello carol']]);
    const ctx = engine(server, alice, { ...config(2, 2), requestTimeoutMs: 3_600_000 });

    const controller = new AbortController();
    const cancelled = receiveMessages(ctx, conversation(alice, bob), controller.signal);
    const outcome = cancelled.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await outcome).toBe('rejected');

    expect(ctx.budget.available()).toBe(2);
    expect(server.state.inFlight).toBe(0);
    const fetch = await receive(ctx, alice, carol);
    expect(contents(fetch)).toEqual(['hello carol']);
  });

  it('rate limited requests wait without holding capacity', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage(100);
    const urls = server.publish(alice, bob, [
      [1, 'limited'],
      [2, 'unaffected'],
      [3, 'gave up'],
    ]);
    const limited = server.body(urls[0]!);
    server.reply(urls[0]!, [{ rateLimited: 3 }, { body: limited }]);
    server.reply(urls[2]!, [{ rateLimited: 60 }]);
    const ctx = engine(server, alice, config(1, 1));

    const fetch = await receive(ctx, alice, bob);

    expect(contents(fetch)).toEqual(['limited', 'unaffected']);
    // Retry-After beyond maxRetryDelayMs is not retried
    expect(fetch.failures).toEqual([
      { url: urls[2], attempts: 1, reason: { kind: 'status', status: 429 } },
    ]);
    const limitedStarts = server.startsOf(urls[0]!);
    const unaffected = server.startsOf(urls[1]!);
    expect(limitedStarts.length).toBe(2);
    // Capacity was used while waiting to retry
    expect(unaffected[0]!).toBeLessThan(limitedStarts[1]!);
    expect(limitedStarts[1]! - limitedStarts[0]!).toBeGreaterThanOrEqual(3100);
    expect(ctx.budget.available()).toBe(1);
  });

  it('failures follow the retry policy and are reported', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage(100);
    const urls = server.publish(alice, bob, [
      [1, 'server error'],
      [2, 'forbidden'],
      [3, 'broken'],
      [4, 'deleted'],
      [5, 'fine'],
    ]);
    server.reply(urls[0]!, [{ status: 500 }]);
    server.reply(urls[1]!, [{ status: 403 }]);
    server.reply(urls[2]!, ['broken', 'broken', { status: 502 }]);
    server.remove(urls[3]!);
    const bobDirectory = directory(bob, alice);
    server.reply(bobDirectory, [{ status: 503 }]);

    const fetch = await receive(engine(server, alice, config(8, 8)), alice, bob);

    expect(contents(fetch)).toEqual(['fine']);
    expect(fetch.failures).toEqual([
      { url: `${bobDirectory}?limit=1000`, attempts: 3, reason: { kind: 'status', status: 503 } },
      { url: urls[0], attempts: 3, reason: { kind: 'status', status: 500 } },
      { url: urls[1], attempts: 1, reason: { kind: 'status', status: 403 } },
      { url: urls[2], attempts: 3, reason: { kind: 'status', status: 502 } },
    ]);
    const starts = server.startsOf(urls[0]!);
    expect(starts[1]! - starts[0]!).toBe(1100);
    expect(starts[2]! - starts[1]!).toBe(2100);
  });

  it('transport errors are retried and reported', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage(10);
    const urls = server.publish(alice, bob, [[1, 'broken']]);
    server.reply(urls[0]!, ['broken']);
    const ctx = engine(server, alice, config(4, 4));

    const fetch = await receive(ctx, alice, bob);

    expect(fetch.failures).toEqual([
      { url: urls[0], attempts: 3, reason: { kind: 'transport', message: 'connection reset' } },
    ]);
    expect(ctx.metrics.snapshot().retries).toBe(2);
  });

  it('listings are read until an empty page', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    server.publish(alice, bob, history('from alice', 5));
    server.publish(bob, alice, [[9, 'from bob']]);

    const fetch = await receive(
      engine(server, alice, { ...config(4, 4), listPageSize: 2 }),
      alice,
      bob,
    );

    expect(fetch.messages.length).toBe(6);
    expect(fetch.failures).toEqual([]);
    // Alice's pages hold 2, 2, 1 and 0 entries, Bob's 1 and 0
    expect(server.state.listingRequests).toBe(6);
  });

  it('a listing that ignores its cursor fails instead of paging forever', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    server.ignoresCursor = true;
    server.publish(alice, bob, [
      [1, 'a'],
      [2, 'b'],
    ]);

    const fetch = await receive(
      engine(server, alice, { ...config(4, 4), listPageSize: 2 }),
      alice,
      bob,
    );

    expect(fetch.messages).toEqual([]);
    expect(fetch.failures.length).toBe(1);
    expect(fetch.failures[0]!.reason).toEqual({ kind: 'listingStalled' });
  });

  it('a listing longer than the entry limit fails', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    server.publish(alice, bob, history('from alice', 5));

    const fetch = await receive(
      engine(server, alice, { ...config(4, 4), listPageSize: 2, maxListingEntries: 3 }),
      alice,
      bob,
    );

    expect(fetch.messages).toEqual([]);
    expect(fetch.failures.length).toBe(1);
    expect(fetch.failures[0]!.reason).toEqual({ kind: 'listingTooLong' });
  });

  it('missing directories are an empty conversation', async () => {
    const server = new FakeStorage(100);
    const fetch = await receive(engine(server, keypair(1), config(4, 4)), keypair(1), keypair(2));
    expect(fetch).toEqual({ messages: [], failures: [] });
  });

  it('listed entries outside the conversation are reported without being requested', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const served = server.publish(alice, bob, [[1, 'mine']]);
    served.push(...server.publish(bob, alice, [[2, 'theirs']]));
    const outside = entriesOutside(bob, alice);
    server.listUnserved(directory(bob, alice), outside);

    // Hostile entries end pages and become cursors
    const fetch = await receive(
      engine(server, alice, { ...config(4, 4), listPageSize: 2 }),
      alice,
      bob,
    );

    expect(contents(fetch)).toEqual(['mine', 'theirs']);
    const sorted = [...outside].sort();
    const expected: FetchFailure[] = sorted.map(outsideConversation);
    expect(fetch.failures).toEqual(expected);
    for (const url of outside) {
      // Alice's message is also listed in Bob's directory, and is requested only from hers
      expect(server.attempts(url)).toBe(served.includes(url) ? 1 : 0);
    }
    expect(describeFetchFailure(expected[0]!)).toBe(
      `${sorted[0]}: not a message in this conversation, not requested`,
    );
  });
});
