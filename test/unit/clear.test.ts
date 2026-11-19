import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Keypair } from '@synonymdev/pubky';
import { clearMessages, deleteMessages, deletionResult } from '../../src/clear';
import { v1Conversation } from '../../src/conversation';
import { Requests, createEngine, type EngineContext, type FetchConfig } from '../../src/engine';
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

function own(author: Keypair, other: Keypair) {
  return v1Conversation(author.secret(), z32(author), z32(other), other.publicKey.toUint8Array())
    .sides[0];
}

const deleteConfig: Partial<FetchConfig> = {
  maxConcurrentRequests: 2,
  maxConcurrentRequestsPerConversation: 2,
  requestTimeoutMs: 1000,
  retryBaseDelayMs: 100,
};

function engine(
  server: FakeStorage,
  owner: Keypair,
  cfg: Partial<FetchConfig> = deleteConfig,
): EngineContext {
  return createEngine(server.storageFor(z32(owner)), cfg);
}

describe('cleanup', () => {
  it('listed entries outside the conversation are not requested', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const sent = server.publish(
      alice,
      bob,
      Array.from({ length: 7 }, (_, i): [number, string] => [i, `sent ${i}`]),
    );
    const received = server.publish(bob, alice, [[9, 'received']]);
    const outside = entriesOutside(alice, bob);
    server.listUnserved(directory(alice, bob), outside);

    // Hostile entries end pages and become cursors
    const report = await settle(
      clearMessages(engine(server, alice, { listPageSize: 2 }), own(alice, bob)),
    );

    expect(() => deletionResult(report)).toThrow(
      new RegExp(
        `^Failed to delete ${outside.length} listing\\(s\\) or message\\(s\\), including `,
      ),
    );
    expect([...server.state.deleted].sort()).toEqual([...sent].sort());
    for (const url of outside) expect(server.attempts(url)).toBe(0);
    // Bob's copy of his message is among the entries outside Alice's directory
    expect(outside).toContain(received[0]);
  });

  it('a failed listing is an error and deletes nothing', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    server.publish(alice, bob, [[1, 'sent']]);
    server.reply(directory(alice, bob), [{ status: 307 }]);

    const report = await settle(clearMessages(engine(server, alice, {}), own(alice, bob)));

    expect(report.deleted).toEqual([]);
    expect(() => deletionResult(report)).toThrow();
    expect(server.state.deleted).toEqual([]);
  });

  it('selected deletions are idempotent and leave other messages', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const sent = server.publish(alice, bob, [
      [1, 'selected'],
      [2, 'keep'],
    ]);
    const received = server.publish(bob, alice, [[3, 'received']]);
    const ids = ['0000', 'absent', '0000'];
    const expected = [sent[0], `${directory(alice, bob)}absent.json`];

    for (let i = 0; i < 2; i++) {
      const report = await settle(deleteMessages(engine(server, alice), own(alice, bob), ids));
      expect(report.deleted).toEqual(expected);
      expect(report.failures).toEqual([]);
    }

    // One attempt per unique ID per call
    expect(server.attempts(sent[0]!)).toBe(2);
    expect(server.attempts(sent[1]!)).toBe(0);
    expect(server.attempts(received[0]!)).toBe(0);
    expect(server.state.deleted).toEqual([sent[0]]);
  });

  it('every ID is validated before any delete', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    server.publish(alice, bob, [[1, 'keep']]);

    for (const invalid of ['', 'contains a space', '.', '..', 'a/b', '%2e']) {
      await expect(
        deleteMessages(engine(server, alice), own(alice, bob), ['0000', invalid]),
      ).rejects.toThrow('Invalid message ID');
      expect(server.state.requests).toBe(0);
    }
  });

  it('deletion retries transient failures and reports every outcome', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const urls = server.publish(alice, bob, [
      [1, 'retry'],
      [2, 'timeout'],
      [3, 'forbidden'],
      [4, 'success'],
      [5, 'not modified'],
    ]);
    server.replyDelete(urls[0]!, ['broken', { status: 503 }, { status: 200 }]);
    server.replyDelete(urls[1]!, ['hang']);
    server.replyDelete(urls[2]!, [{ status: 403 }]);
    server.replyDelete(urls[4]!, [{ status: 304 }]);
    const ids = urls.map((_, i) => String(i).padStart(4, '0'));
    const ctx = engine(server, alice);

    const report = await settle(deleteMessages(ctx, own(alice, bob), ids));

    expect(report.deleted).toEqual([urls[0], urls[3]]);
    expect(report.failures).toEqual([
      { url: urls[1], attempts: 3, reason: { kind: 'timedOut' } },
      { url: urls[2], attempts: 1, reason: { kind: 'status', status: 403 } },
      { url: urls[4], attempts: 1, reason: { kind: 'status', status: 304 } },
    ]);
    expect(server.attempts(urls[0]!)).toBe(3);
    expect(ctx.budget.available()).toBe(2);
    expect(server.state.inFlight).toBe(0);
  });

  it('rate limited deletes release capacity and honor Retry-After', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const urls = server.publish(alice, bob, [
      [1, 'limited'],
      [2, 'ready'],
      [3, 'wait too long'],
    ]);
    server.replyDelete(urls[0]!, [{ rateLimited: 3 }, { status: 200 }]);
    server.replyDelete(urls[2]!, [{ rateLimited: 60 }]);
    const ids = ['0000', '0001', '0002'];

    const report = await settle(
      deleteMessages(
        engine(server, alice, { ...deleteConfig, maxConcurrentRequests: 1 }),
        own(alice, bob),
        ids,
      ),
    );

    expect(report.deleted).toEqual(urls.slice(0, 2));
    expect(report.failures.length).toBe(1);
    expect(report.failures[0]!.attempts).toBe(1);
    const retries = server.startsOf(urls[0]!);
    expect(retries[1]! - retries[0]!).toBeGreaterThanOrEqual(3000);
    expect(server.startsOf(urls[1]!)[0]!).toBeLessThan(retries[1]!);
  });

  it('reads and deletes share the client budget', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const carol = keypair(3);
    const server = new FakeStorage(50);
    const deleted = server.publish(
      alice,
      bob,
      Array.from({ length: 12 }, (_, i): [number, string] => [i, 'sent']),
    );
    const kept = server.publish(alice, carol, [[1, 'keep']]);
    const ctx = engine(server, alice, { ...deleteConfig, maxConcurrentRequestsPerConversation: 1 });
    const requests = new Requests(ctx);

    const [deletion, read] = await settle(
      Promise.all([clearMessages(ctx, own(alice, bob)), requests.retrieve(kept[0]!)]),
    );

    expect(deletion.deleted).toEqual(deleted);
    expect(read.ok).toBe(true);
    expect(server.state.peak).toBe(2);
    expect([...server.state.peakByConversation.values()].every((p) => p === 1)).toBe(true);
    expect(ctx.budget.available()).toBe(2);
  });

  it('cancelling deletion releases capacity for later cleanup', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const urls = server.publish(alice, bob, [[1, 'slow once']]);
    server.replyDelete(urls[0]!, ['hang', { status: 200 }]);
    const ctx = engine(server, alice, { ...deleteConfig, maxConcurrentRequests: 1 });

    const controller = new AbortController();
    const outcome = deleteMessages(ctx, own(alice, bob), ['0000'], controller.signal).then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await outcome).toBe('rejected');
    expect(ctx.budget.available()).toBe(1);
    expect(server.state.inFlight).toBe(0);

    const report = await settle(deleteMessages(ctx, own(alice, bob), ['0000']));
    expect(report.deleted).toEqual(urls);
    expect(report.failures).toEqual([]);
  });
});
