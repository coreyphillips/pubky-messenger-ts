import { describe, expect, it, vi } from 'vitest';
import type { Pubky, Session } from '@synonymdev/pubky';
import { PrivateMessengerClient } from '../../src/client';
import { ConversationKey } from '../../src/crypto';
import { FetchFailureError } from '../../src/engine';
import { StorageError, createPubkyStorage, storageErrorInfo } from '../../src/storage';
import { PrivateMessage } from '../../src/message';
import { decrypt, encrypt } from '../../src/secretbox';
import { parseZ32PublicKey, z32Decode, z32Encode } from '../../src/z32';
import { keypair } from '../support/fake-storage';

const sdkError = (status: number, name = 'RequestError') =>
  Object.assign(new Error(`Server responded with an error: ${status}`), {
    name,
    data: { reason: 'Http', statusCode: status },
  });

function fakeSession(put: (path: string) => Promise<void> = async () => {}) {
  return {
    storage: {
      putBytes: vi.fn(put),
      delete: vi.fn(async (_path: string) => {}),
      putJson: vi.fn(async () => {}),
    },
  } as unknown as Session & {
    storage: { putBytes: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  };
}

function fakePubky(overrides: Record<string, unknown> = {}) {
  const signer = {
    signin: vi.fn(async (_clientId: string) => fakeSession()),
    signinCookie: vi.fn(async () => fakeSession()),
    signup: vi.fn(async () => {}),
  };
  const pubky = {
    signer: vi.fn(() => signer),
    getHomeserverOf: vi.fn(async () => undefined),
    publicStorage: {
      list: vi.fn(async () => [] as string[]),
      getBytes: vi.fn(async () => new Uint8Array()),
      getJson: vi.fn(async () => null),
    },
    client: { fetch: vi.fn() },
    ...overrides,
  };
  return { pubky: pubky as unknown as Pubky, raw: pubky, signer };
}

describe('default storage adapter', () => {
  it('maps SDK errors: 404 reads are missing, 404 deletes succeed, 401 writes are authentication failures', async () => {
    const { pubky, raw } = fakePubky();
    const session = fakeSession(async () => {
      throw sdkError(401);
    });
    (session.storage.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(sdkError(404));
    raw.publicStorage.getBytes.mockRejectedValueOnce(sdkError(404));
    raw.publicStorage.list.mockResolvedValueOnce(['pubky://a/pub/x/1']);
    const storage = createPubkyStorage(pubky, session);

    expect(await storage.get('pubky://a/pub/x/1')).toBeNull();
    expect(
      await storage.list('pubky://a/pub/x/', { cursor: 'pubky://a/pub/x/0', limit: 7 }),
    ).toEqual(['pubky://a/pub/x/1']);
    expect(raw.publicStorage.list).toHaveBeenCalledWith(
      'pubky://a/pub/x/',
      'pubky://a/pub/x/0',
      false,
      7,
      false,
    );
    await expect(storage.delete('/pub/x/1')).resolves.toBeUndefined();
    const error = await storage.put('/pub/x/1', new Uint8Array([1])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ status: 401, authentication: true });

    raw.publicStorage.getBytes.mockRejectedValueOnce(sdkError(503));
    await expect(storage.get('pubky://a/pub/x/1')).rejects.toMatchObject({
      status: 503,
      authentication: false,
    });
  });

  it('a read-only adapter cannot write', async () => {
    const { pubky } = fakePubky();
    await expect(createPubkyStorage(pubky).put('/pub/x', new Uint8Array())).rejects.toMatchObject({
      authentication: true,
    });
  });

  it('conditional GET reports entity tags, 304, Retry-After and refuses redirects', async () => {
    const { pubky, raw } = fakePubky();
    const storage = createPubkyStorage(pubky);
    const address = 'pubky://w5ux3c55ujxq7rpb6x9z9wo554s4eb4zeuh1933b94zk7qsfxd1o/pub/x/1.json';
    raw.client.fetch.mockResolvedValueOnce(
      new Response('hello', { status: 200, headers: { etag: '"t"' } }),
    );
    const found = await storage.getConditional!(address, {});
    expect(found).toEqual({
      notModified: false,
      body: new TextEncoder().encode('hello'),
      etag: '"t"',
    });
    const [url, init] = raw.client.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/_pubky\.w5ux3c55/);
    expect(init.redirect).toBe('manual');

    raw.client.fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect(await storage.getConditional!(address, { ifNoneMatch: '"t"' })).toEqual({
      notModified: true,
    });
    expect((raw.client.fetch.mock.calls[1]![1] as RequestInit).headers).toEqual({
      'If-None-Match': '"t"',
    });

    raw.client.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await storage.getConditional!(address, {})).toBeNull();

    raw.client.fetch.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'retry-after': '5' } }),
    );
    await expect(storage.getConditional!(address, {})).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 5000,
    });

    raw.client.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    );
    await expect(storage.getConditional!(address, {})).rejects.toMatchObject({ status: 302 });
  });

  it('reads status and classification from any error shape', () => {
    expect(storageErrorInfo(sdkError(429))).toMatchObject({ status: 429, authentication: false });
    expect(storageErrorInfo(sdkError(403, 'CredentialRefreshError'))).toMatchObject({
      status: 403,
      authentication: true,
    });
    expect(
      storageErrorInfo(Object.assign(new Error('x'), { name: 'CredentialRefreshError' })),
    ).toMatchObject({
      status: undefined,
      authentication: false,
    });
    expect(storageErrorInfo({ status: 500 }).status).toBe(500);
    expect(storageErrorInfo(new TypeError('fetch failed')).message).toBe('TypeError: fetch failed');
    expect(StorageError.fromStatus(503, { retryAfterMs: 1000 })).toMatchObject({
      status: 503,
      retryAfterMs: 1000,
      authentication: false,
    });
  });
});

describe('client sessions', () => {
  it('concurrent first writes share one grant sign-in with the client ID', async () => {
    const { pubky, signer } = fakePubky();
    const client = new PrivateMessengerClient(keypair(1), { pubky });
    const bob = keypair(2);
    await Promise.all([
      client.sendMessage(bob.publicKey, 'a'),
      client.sendMessage(bob.publicKey, 'b'),
    ]);
    expect(signer.signin).toHaveBeenCalledTimes(1);
    expect(signer.signin).toHaveBeenCalledWith('pubky-messenger');
    expect(client.requestStats().session.attempts).toBe(1);
    expect(client.requestStats().put.attempts).toBe(2);
    expect(client.currentSession()).not.toBeNull();
  });

  it('a rejected session is renewed once per attempt, then classified', async () => {
    const { pubky, signer } = fakePubky();
    const rejecting = fakeSession(async () => {
      throw sdkError(401);
    });
    const accepting = fakeSession();
    signer.signin.mockResolvedValueOnce(rejecting).mockResolvedValueOnce(accepting);
    const client = new PrivateMessengerClient(keypair(1), { pubky });
    await client.sendMessage(keypair(2).publicKey, 'renewed');
    expect(signer.signin).toHaveBeenCalledTimes(2);
    expect(accepting.storage.putBytes).toHaveBeenCalledTimes(1);

    const { pubky: p2, signer: s2 } = fakePubky();
    s2.signin.mockImplementation(async () =>
      fakeSession(async () => {
        throw sdkError(401);
      }),
    );
    const stuck = new PrivateMessengerClient(keypair(1), { pubky: p2 });
    const error = await stuck.sendMessage(keypair(2).publicKey, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchFailureError);
    expect((error as FetchFailureError).failure.reason).toEqual({
      kind: 'authentication',
      status: 401,
    });
    expect((error as FetchFailureError).failure.attempts).toBe(1);
  });

  it('failed session establishment keeps its status as an authentication failure', async () => {
    const { pubky, signer } = fakePubky();
    signer.signin.mockRejectedValue(sdkError(403));
    const client = new PrivateMessengerClient(keypair(1), { pubky });
    const error = await client.deleteMessagesWithReport(['0000'], keypair(2).publicKey);
    expect(error.failures[0]!.reason).toEqual({ kind: 'authentication', status: 403 });
  });

  it('signIn falls back to the cookie flow on a homeserver without grants', async () => {
    const { pubky, signer } = fakePubky();
    signer.signin.mockRejectedValueOnce(sdkError(404));
    const client = new PrivateMessengerClient(keypair(1), { pubky, clientId: 'my-app' });
    await client.signIn();
    expect(signer.signin).toHaveBeenCalledWith('my-app');
    expect(signer.signinCookie).toHaveBeenCalledTimes(1);
  });

  it('ensureSession signs up only when no homeserver record resolves', async () => {
    const homeserver = keypair(9).publicKey.z32();

    const fresh = fakePubky();
    fresh.signer.signin.mockRejectedValueOnce(sdkError(401));
    await new PrivateMessengerClient(keypair(1), { pubky: fresh.pubky }).ensureSession(homeserver);
    expect(fresh.signer.signup).toHaveBeenCalledTimes(1);
    expect(fresh.signer.signin).toHaveBeenCalledTimes(2);

    const existing = fakePubky();
    existing.signer.signin.mockRejectedValueOnce(sdkError(500));
    existing.raw.getHomeserverOf.mockResolvedValueOnce(keypair(8).publicKey as never);
    await expect(
      new PrivateMessengerClient(keypair(1), { pubky: existing.pubky }).ensureSession(homeserver),
    ).rejects.toMatchObject({ data: { statusCode: 500 } });
    expect(existing.signer.signup).not.toHaveBeenCalled();

    const lookupFails = fakePubky();
    lookupFails.signer.signin.mockRejectedValueOnce(sdkError(500));
    lookupFails.raw.getHomeserverOf.mockRejectedValueOnce(new Error('pkarr down'));
    await expect(
      new PrivateMessengerClient(keypair(1), { pubky: lookupFails.pubky }).ensureSession(
        homeserver,
      ),
    ).rejects.toMatchObject({ data: { statusCode: 500 } });
    expect(lookupFails.signer.signup).not.toHaveBeenCalled();
  });

  it('signUp redacts the signup token from errors', async () => {
    const { pubky, signer } = fakePubky();
    signer.signup.mockRejectedValueOnce(
      new Error('GET https://hs/signup?token=AAAA-BBBB-CCCC failed'),
    );
    const client = new PrivateMessengerClient(keypair(1), { pubky });
    const error = (await client
      .signUp(keypair(9).publicKey, 'AAAA-BBBB-CCCC')
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('AAAA-BBBB-CCCC');
  });
});

describe('wire details', () => {
  it('empty plaintext encrypts to empty bytes and round-trips as an empty message', () => {
    const key = new Uint8Array(32).fill(7);
    expect(encrypt(new Uint8Array(), key)).toEqual(new Uint8Array());
    expect(decrypt(new Uint8Array(), key)).toEqual(new Uint8Array());
    const alice = keypair(1);
    const bob = keypair(2);
    const message = PrivateMessage.create(alice, bob.publicKey, '');
    expect(message.encryptedContent.length).toBe(0);
    expect(message.decryptContent(bob, alice.publicKey)).toBe('');
    expect(message.verifySignature('', alice.publicKey.z32())).toBe(true);
  });

  it('decrypts content strictly: invalid UTF-8 is an error, a BOM is kept', () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const valid = PrivateMessage.create(alice, bob.publicKey, '﻿hi');
    expect(valid.decryptContent(bob, alice.publicKey)).toBe('﻿hi');

    const invalid = new PrivateMessage(
      valid.timestamp,
      valid.encryptedSender,
      encrypt(new Uint8Array([0xff, 0xfe]), conversationKeyBytes(alice, bob)),
      valid.signatureBytes,
    );
    expect(() => invalid.decryptContent(bob, alice.publicKey)).toThrow();
  });

  it('encrypts the bare z-base-32 sender', () => {
    const alice = keypair(1);
    const bob = keypair(2);
    const message = PrivateMessage.create(alice, bob.publicKey, 'hi');
    expect(message.decryptSender(bob, alice.publicKey)).toBe(alice.publicKey.z32());
    expect(alice.publicKey.toString()).not.toBe(alice.publicKey.z32());
  });

  it('z-base-32 matches the SDK and rejects non-canonical text', () => {
    for (let i = 0; i < 20; i++) {
      const kp = keypair(i + 1);
      expect(z32Encode(kp.publicKey.toUint8Array())).toBe(kp.publicKey.z32());
      expect(z32Decode(kp.publicKey.z32())).toEqual(kp.publicKey.toUint8Array());
    }
    const good = keypair(1).publicKey.z32();
    expect(() => parseZ32PublicKey(good)).not.toThrow();
    expect(() => parseZ32PublicKey(`pubky${good}`)).toThrow();
    expect(() => parseZ32PublicKey(good.toUpperCase())).toThrow();
    expect(() => parseZ32PublicKey(good.slice(0, 51))).toThrow();
    // The last character carries 4 padding bits that must be zero
    const last = good[51]!;
    const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';
    const bumped = alphabet[(alphabet.indexOf(last) ^ 1) % 32]!;
    expect(() => parseZ32PublicKey(good.slice(0, 51) + bumped)).toThrow();
  });
});

function conversationKeyBytes(
  a: ReturnType<typeof keypair>,
  b: ReturnType<typeof keypair>,
): Uint8Array {
  return ConversationKey.derive(a.secret(), b.publicKey.toUint8Array()).encryptionKey();
}
