import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMessages } from '../../src/clear';
import { receiveMessages, v1Conversation } from '../../src/conversation';
import { FetchFailureError, createEngine, type FetchConfig } from '../../src/engine';
import { decodeUtf8Strict } from '../../src/bytes';
import { PrivateMessengerClient } from '../../src/client';
import { PreparedMessage, prepareV1, publishPrepared, v1Destination } from '../../src/prepared';
import { FakeStorage, keypair, settle, z32 } from '../support/fake-storage';
import type { Keypair } from '@synonymdev/pubky';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function prepare(
  author: Keypair,
  recipient: Keypair,
  content: string,
  timestamp?: number,
): PreparedMessage {
  return prepareV1(author.secret(), z32(author), z32(recipient), content, timestamp);
}

async function publish(
  ctx: ReturnType<typeof createEngine>,
  author: Keypair,
  prepared: PreparedMessage,
): Promise<string> {
  const url = v1Destination(prepared, author.secret(), z32(author));
  return publishPrepared(ctx, url, prepared);
}

function conv(reader: Keypair, other: Keypair) {
  return v1Conversation(reader.secret(), z32(reader), z32(other), other.publicKey.toUint8Array());
}

describe('PreparedMessage', () => {
  it('serializes to the Rust serde shape and round-trips', () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const prepared = prepare(alice, bob, 'durable request', 1_700_000_000);
    const json = prepared.toJSON();
    expect(Object.keys(json)).toEqual([
      'version',
      'id',
      'owner',
      'recipient',
      'payload',
      'signature',
    ]);
    expect(json.version).toBe(1);
    expect(json.owner).toBe(z32(alice));
    expect(json.recipient).toBe(z32(bob));
    expect(json.signature.length).toBe(64);
    expect(prepared.id()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(prepared.timestamp()).toBe(1_700_000_000);
    // The payload is the exact serialized v1 message
    expect(JSON.parse(decodeUtf8Strict(prepared.payload()))).toMatchObject({
      timestamp: 1_700_000_000,
    });

    const restored = PreparedMessage.fromJSON(JSON.parse(JSON.stringify(prepared)));
    expect(restored.toJSON()).toEqual(json);
    expect(() => restored.validate()).not.toThrow();
    expect(PreparedMessage.deserialize(prepared.serialize()).serialize()).toBe(
      prepared.serialize(),
    );
    expect(String(prepared)).not.toContain('payload:');
  });

  it('rejects unknown, missing and mistyped fields when restoring', () => {
    const json = prepare(keypair(1), keypair(2), 'x').toJSON();
    expect(() => PreparedMessage.fromJSON({ ...json, extra: 1 })).toThrow(/unknown field/);
    const { id: _id, ...missing } = json;
    expect(() => PreparedMessage.fromJSON(missing)).toThrow();
    expect(() => PreparedMessage.fromJSON({ ...json, version: 256 })).toThrow();
    expect(() => PreparedMessage.fromJSON({ ...json, payload: [1, 256] })).toThrow();
    expect(() => PreparedMessage.fromJSON({ ...json, owner: 7 })).toThrow();
  });

  it('a saved message retries after storage loses its response', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const prepared = prepare(alice, bob, 'durable request');
    const saved = JSON.stringify(prepared);
    const url = v1Destination(prepared, alice.secret(), z32(alice));
    const server = new FakeStorage();
    server.replyPut(url, ['storedThenBroken', { status: 200 }]);
    const ctx = createEngine(server.storageFor(z32(alice)), { maxAttempts: 1 });
    await expect(settle(publish(ctx, alice, prepared))).rejects.toBeInstanceOf(FetchFailureError);

    const restored = PreparedMessage.fromJSON(JSON.parse(saved));
    expect(await settle(publish(ctx, alice, restored))).toBe(prepared.id());
    expect(server.body(url)).toBe(decodeUtf8Strict(prepared.payload()));
    const stats = ctx.metrics.snapshot();
    expect(stats.put.attempts).toBe(2);
    expect(stats.put.requestBodyBytes).toBe(prepared.payload().length * 2);
    const history = await settle(receiveMessages(ctx, conv(alice, bob)));
    expect(history.messages.map((m) => m.content)).toEqual(['durable request']);
    for (const [target, body] of server.state.putBodies) {
      expect(target).toBe(url);
      expect(body).toEqual(prepared.payload());
    }
  });

  it('concurrent retries use one resource and identical bytes', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const prepared = prepare(alice, bob, 'one resource');
    const server = new FakeStorage(50);
    const ctx = createEngine(server.storageFor(z32(alice)), { maxConcurrentRequests: 3 });

    const results = await settle(
      Promise.all(Array.from({ length: 8 }, () => publish(ctx, alice, prepared))),
    );

    expect(results.every((id) => id === prepared.id())).toBe(true);
    const history = await settle(receiveMessages(ctx, conv(alice, bob)));
    expect(history.messages.length).toBe(1);
    expect(server.state.peak).toBe(3);
    expect(
      server.state.putBodies.every(([, body]) => body.join() === prepared.payload().join()),
    ).toBe(true);
    expect(ctx.metrics.snapshot().queueWaitMs).toBeGreaterThan(0);
  });

  it('restored values are validated before requests', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const prepared = prepare(alice, bob, 'bound payload');
    const server = new FakeStorage();
    const ctx = createEngine(server.storageFor(z32(alice)));
    // Another identity cannot publish it
    expect(() => v1Destination(prepared, keypair(3).secret(), z32(keypair(3)))).toThrow(
      /another identity/,
    );
    expect(() => prepared.validate()).not.toThrow();

    const original = prepared.toJSON();
    const replacements: Array<[keyof typeof original, unknown]> = [
      ['version', 2],
      ['id', 'not-a-message-id'],
      ['id', globalThis.crypto.randomUUID()],
      ['id', original.id.toUpperCase()],
      ['owner', z32(keypair(3))],
      ['owner', `pubky${original.owner}`],
      ['recipient', z32(keypair(3))],
      ['payload', [1, 2, 3]],
      ['signature', []],
    ];
    for (const [field, replacement] of replacements) {
      const restored = PreparedMessage.fromJSON({ ...original, [field]: replacement });
      expect(() => restored.validate(), `${field}`).toThrow();
      await expect(publish(ctx, alice, restored)).rejects.toThrow();
    }
    // A flipped payload byte breaks the binding
    const tampered = { ...original, payload: [...original.payload] };
    tampered.payload[20] = tampered.payload[20] === 49 ? 50 : 49;
    expect(() => PreparedMessage.fromJSON(tampered).validate()).toThrow(/authentication failed/);
    expect(server.state.requests).toBe(0);
  });

  it('publication retries transient failures and reports permanent statuses', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const cfg: Partial<FetchConfig> = { requestTimeoutMs: 1000, maxConcurrentRequests: 2 };
    for (const status of [401, 403, 404]) {
      const server = new FakeStorage();
      const prepared = prepare(alice, bob, 'permanent');
      server.replyPut(v1Destination(prepared, alice.secret(), z32(alice)), [{ status }]);
      const ctx = createEngine(server.storageFor(z32(alice)), cfg);
      const error = await settle(publish(ctx, alice, prepared)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FetchFailureError);
      expect((error as FetchFailureError).failure.reason).toEqual({ kind: 'status', status });
      expect((error as FetchFailureError).failure.attempts).toBe(1);
    }
    const server = new FakeStorage();
    const prepared = prepare(alice, bob, 'retry');
    server.replyPut(v1Destination(prepared, alice.secret(), z32(alice)), [
      'hang',
      { status: 503 },
      { status: 200 },
    ]);
    const ctx = createEngine(server.storageFor(z32(alice)), cfg);
    await settle(publish(ctx, alice, prepared));
    const stats = ctx.metrics.snapshot();
    expect(stats.put.attempts).toBe(3);
    expect(stats.retries).toBe(2);
    expect(stats.timeouts).toBe(1);
    expect(ctx.budget.available()).toBe(2);
  });

  it('a persistent authentication failure is classified', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const prepared = prepare(alice, bob, 'auth');
    const ctx = createEngine({
      list: async () => [],
      get: async () => null,
      put: async () => {
        throw Object.assign(new Error('refresh failed'), {
          name: 'CredentialRefreshError',
          data: { statusCode: 403 },
        });
      },
      delete: async () => {},
    });
    const error = await settle(publish(ctx, alice, prepared)).catch((e: unknown) => e);
    expect((error as FetchFailureError).failure).toEqual({
      url: v1Destination(prepared, alice.secret(), z32(alice)),
      attempts: 1,
      reason: { kind: 'authentication', status: 403 },
    });
  });

  it('a cleanup backlog leaves capacity for foreground publication', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage(50);
    const backlog = Array.from({ length: 12 }, (_, i): [number, string] => [i, 'old']);
    for (const url of server.publish(alice, bob, backlog)) server.delays.set(url, 1000);
    const prepared = prepare(alice, bob, 'foreground');
    const ctx = createEngine(server.storageFor(z32(alice)), { maxConcurrentRequests: 4 });

    const foreground = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const start = Date.now();
      await publish(ctx, alice, prepared);
      return Date.now() - start;
    })();
    const [report, elapsed] = await settle(
      Promise.all([clearMessages(ctx, conv(alice, bob).sides[0]), foreground]),
    );

    expect(elapsed).toBe(50);
    expect(report.deleted.length).toBe(12);
    expect(server.state.peak).toBeLessThanOrEqual(4);
    const stats = ctx.metrics.snapshot();
    expect(stats.delete.attempts).toBe(12);
    expect(stats.put.attempts).toBe(1);
    expect(stats.list.attempts).toBe(2);
  });

  it('the client publishes through an injected storage and counts no session', async () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const server = new FakeStorage();
    const client = new PrivateMessengerClient(alice, { storage: server.storageFor(z32(alice)) });
    const prepared = client.prepareMessage(bob.publicKey, 'hello');
    expect(client.requestStats().put.attempts).toBe(0);
    expect(await settle(client.publishMessage(prepared))).toBe(prepared.id());
    expect(client.requestStats().session.attempts).toBe(0);
    const bobClient = new PrivateMessengerClient(bob, { storage: server.storageFor(z32(bob)) });
    const messages = await settle(bobClient.getMessages(z32(alice)));
    expect(messages.map((m) => [m.sender, m.content, m.verified])).toEqual([
      [z32(alice), 'hello', true],
    ]);
    // Bob cannot publish Alice's prepared message
    await expect(bobClient.publishMessage(prepared)).rejects.toThrow(/another identity/);
  });
});
