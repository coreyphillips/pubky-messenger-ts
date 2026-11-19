import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Keypair } from '@synonymdev/pubky';
import { decodeUtf8Strict, utf8 } from '../../src/bytes';
import { PrivateMessengerClient } from '../../src/client';
import { ConversationKey } from '../../src/crypto';
import { isMessageUrl, messageUuid } from '../../src/engine';
import { ReceiveState } from '../../src/incremental';
import { PreparedMessage } from '../../src/prepared';
import { MessengerV2Client, MessagingNotEnabledError } from '../../src/v2/client';
import {
  KEY_RECORD_PATH,
  MESSAGING_CAPABILITIES,
  MESSAGING_KEY_PATH,
  MessagingIdentity,
  deriveFileContentKey,
  deriveMessagingSeed,
} from '../../src/v2/keys';
import { v2Conversation, v2MessageDigest } from '../../src/v2/message';
import { InvalidKeyRecordError, buildKeyRecord, parseKeyRecord } from '../../src/v2/record';
import { FakeStorage, settle } from '../support/fake-storage';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

const secret = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('messaging seed', () => {
  it('matches the spec vectors', () => {
    expect(bytesToHex(deriveMessagingSeed(secret(0x11)))).toBe(
      '1b217aeb88b26eafca4805fbca7195036b70a5163641df2716e3c681c0cbf569',
    );
    expect(bytesToHex(deriveMessagingSeed(secret(0x22)))).toBe(
      '313083956f1fdeaa0b872a814d9f5051819796f5a9629fcd3286f63b49c31f9c',
    );
    const p1 = Keypair.fromRecoveryFile(fixture('p1.pkarr'), 'password');
    expect(bytesToHex(deriveMessagingSeed(p1.secret()))).toBe(
      '34d4621ddc5bc6479b99a908ca624bebf876d9b753d0688b3a9af371f9ac9f8a',
    );
  });

  it('uses the documented path and capabilities', () => {
    expect(MESSAGING_KEY_PATH).toBe('/priv/private_messages/v2/messaging-key');
    expect(KEY_RECORD_PATH).toBe('/pub/private_messages/v2/key.json');
    expect(MESSAGING_CAPABILITIES).toBe(
      '/pub/private_messages/:rw,/priv/private_messages/v2/messaging-key:e',
    );
    expect(deriveFileContentKey(secret(0x11), MESSAGING_KEY_PATH)).toEqual(
      deriveMessagingSeed(secret(0x11)),
    );
    for (const bad of ['priv/x', '/priv/dir/', '/priv//x', '/priv/../x', '/priv/./x']) {
      expect(() => deriveFileContentKey(secret(1), bad), bad).toThrow();
    }
    expect(() => deriveMessagingSeed(new Uint8Array(31))).toThrow();
  });

  it('MessagingIdentity copies the seed and zeroes it on dispose', () => {
    const seed = deriveMessagingSeed(secret(0x11));
    const identity = MessagingIdentity.fromSeed(seed);
    const key = identity.publicKeyZ32();
    seed.fill(0);
    expect(identity.publicKeyZ32()).toBe(key);
    expect(MessagingIdentity.fromIdentitySecret(secret(0x11)).publicKeyZ32()).toBe(key);
    expect(identity.disposed).toBe(false);
    identity.dispose();
    expect(identity.disposed).toBe(true);
    expect(() =>
      buildKeyRecord(identity, Keypair.fromSecret(secret(0x11)).publicKey.z32(), 1),
    ).toThrow(/disposed/);
    expect(() => MessagingIdentity.fromSeed(new Uint8Array(16))).toThrow();
  });
});

describe('key records', () => {
  const owner = Keypair.fromSecret(secret(0x11)).publicKey.z32();
  const identity = MessagingIdentity.fromIdentitySecret(secret(0x11));

  it('build and parse round trip in the documented shape', () => {
    const { record, body } = buildKeyRecord(identity, owner, 1_763_000_000_000_000);
    const json = JSON.parse(decodeUtf8Strict(body));
    expect(Object.keys(json)).toEqual([
      'version',
      'owner',
      'messaging_key',
      'created_at',
      'signature',
    ]);
    expect(json.messaging_key).toBe(identity.publicKeyZ32());
    expect(json.signature.length).toBe(64);
    expect(record).toEqual({
      version: 2,
      owner,
      messagingKey: identity.publicKeyZ32(),
      createdAt: 1_763_000_000_000_000,
    });
    expect(parseKeyRecord(body, owner)).toEqual(record);
    // Unknown fields are ignored
    expect(parseKeyRecord(JSON.stringify({ ...json, extra: true }), owner)).toEqual(record);
  });

  it('rejects tampered records', () => {
    const { body } = buildKeyRecord(identity, owner, 1);
    const json = JSON.parse(decodeUtf8Strict(body));
    const other = Keypair.fromSecret(secret(0x22)).publicKey.z32();
    const otherIdentity = MessagingIdentity.fromIdentitySecret(secret(0x22));
    const flipped = [...json.signature];
    flipped[0] ^= 1;
    const cases: Array<[string, unknown, string]> = [
      ['owner mismatch', json, other],
      ['owner field changed', { ...json, owner: other }, owner],
      ['bad signature', { ...json, signature: flipped }, owner],
      ['another messaging key', { ...json, messaging_key: otherIdentity.publicKeyZ32() }, owner],
      ['wrong version', { ...json, version: 1 }, owner],
      ['version as text', { ...json, version: '2' }, owner],
      ['prefixed key', { ...json, messaging_key: `pubky${json.messaging_key}` }, owner],
      [
        'small-order key',
        { ...json, messaging_key: 'yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' },
        owner,
      ],
      ['negative created_at', { ...json, created_at: -1 }, owner],
      ['short signature', { ...json, signature: json.signature.slice(1) }, owner],
    ];
    for (const [name, value, expected] of cases) {
      expect(() => parseKeyRecord(JSON.stringify(value), expected), name).toThrow(
        InvalidKeyRecordError,
      );
    }
    expect(() => parseKeyRecord('not json', owner)).toThrow(InvalidKeyRecordError);
    // Signed by another messaging key for this owner
    const forged = buildKeyRecord(otherIdentity, owner, 1).body;
    const forgedJson = JSON.parse(decodeUtf8Strict(forged));
    expect(() =>
      parseKeyRecord(
        JSON.stringify({ ...forgedJson, messaging_key: identity.publicKeyZ32() }),
        owner,
      ),
    ).toThrow(InvalidKeyRecordError);
  });
});

interface Party {
  owner: string;
  keypair: Keypair;
  identity: MessagingIdentity;
  client: MessengerV2Client;
}

function party(server: FakeStorage, byte: number, now = () => 1_763_000_000_000): Party {
  const keypair = Keypair.fromSecret(secret(byte));
  const owner = keypair.publicKey.z32();
  const identity = MessagingIdentity.fromSeed(deriveMessagingSeed(keypair.secret()));
  return {
    owner,
    keypair,
    identity,
    client: new MessengerV2Client({ owner, identity, storage: server.storageFor(owner), now }),
  };
}

function directories(a: Party, b: Party): [string, string] {
  const c = v2Conversation({
    identity: a.identity,
    owner: a.owner,
    peer: b.owner,
    peerMessagingKey: b.identity.publicKeyZ32(),
  });
  return [c.sides[0].directory, c.sides[1].directory];
}

describe('MessengerV2Client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('messages both ways, receives incrementally, deletes and discovers', async () => {
    const server = new FakeStorage(10);
    let clock = 1_763_000_000_000;
    const now = (): number => clock;
    const alice = party(server, 0x11, now);
    const bob = party(server, 0x22, now);
    const carol = party(server, 0x33, now);

    // Nothing is enabled yet
    expect(await settle(alice.client.fetchKeyRecord(bob.owner))).toBeNull();
    await expect(settle(alice.client.sendMessage(bob.owner, 'too early'))).rejects.toBeInstanceOf(
      MessagingNotEnabledError,
    );

    const aliceRecord = await settle(alice.client.publishKeyRecord());
    expect(aliceRecord).toEqual({
      version: 2,
      owner: alice.owner,
      messagingKey: alice.identity.publicKeyZ32(),
      createdAt: 1_763_000_000_000_000,
    });
    await settle(bob.client.publishKeyRecord());
    expect(server.body(`pubky://${bob.owner}${KEY_RECORD_PATH}`)).toContain(
      bob.identity.publicKeyZ32(),
    );
    expect(await settle(alice.client.fetchKeyRecord(bob.owner))).toMatchObject({
      messagingKey: bob.identity.publicKeyZ32(),
    });

    const fromAlice = await settle(alice.client.sendMessage(bob.owner, 'hello bob 👋'));
    clock += 5000;
    const fromBob = await settle(bob.client.sendMessage(alice.owner, 'hi alice'));

    const [aliceDir, bobDir] = directories(alice, bob);
    expect(aliceDir).toMatch(
      new RegExp(`^pubky://${alice.owner}/pub/private_messages/v2/[0-9a-f]{64}/$`),
    );
    expect(server.entries(aliceDir)).toEqual([`${aliceDir}${fromAlice}.json`]);
    expect(server.entries(bobDir)).toEqual([`${bobDir}${fromBob}.json`]);
    expect(directories(bob, alice)).toEqual([bobDir, aliceDir]);

    for (const reader of [alice, bob]) {
      const peer = reader === alice ? bob : alice;
      const fetch = await settle(reader.client.fetchMessages(peer.owner));
      expect(fetch.failures).toEqual([]);
      expect(fetch.messages).toEqual([
        { sender: alice.owner, content: 'hello bob 👋', timestamp: 1_763_000_000, verified: true },
        { sender: bob.owner, content: 'hi alice', timestamp: 1_763_000_005, verified: true },
      ]);
    }

    // Incremental receive with a state restored from JSON
    const state = new ReceiveState();
    const first = await settle(bob.client.receiveNewMessages(alice.owner, state));
    expect(first.complete).toBe(true);
    expect(first.messages.map((m) => messageUuid(m.id))).toEqual([fromAlice, fromBob]);
    for (const m of first.messages) state.acknowledge(m);
    const restored = ReceiveState.fromJSON(JSON.parse(JSON.stringify(state)));
    const third = await settle(alice.client.sendMessage(bob.owner, 'third'));
    const next = await settle(bob.client.receiveNewMessages(alice.owner, restored));
    expect(next.messages.map((m) => [messageUuid(m.id), m.message?.content])).toEqual([
      [third, 'third'],
    ]);
    for (const m of next.messages) restored.acknowledge(m);

    // Alice unsends her first message; Bob's next complete listing drops it
    const report = await settle(
      alice.client.deleteMessagesWithReport([fromAlice, fromAlice], bob.owner),
    );
    expect(report).toEqual({ deleted: [`${aliceDir}${fromAlice}.json`], failures: [] });
    await settle(bob.client.discoverMessages(alice.owner, restored));
    expect(restored.lastListingComplete).toBe(true);
    expect(
      restored
        .acknowledgedIds()
        .map((id) => messageUuid(id))
        .sort(),
    ).toEqual([fromBob, third].sort());

    // Discovery from Bob's side
    const discovery = await settle(
      bob.client.discoverConversations([alice.owner, carol.owner, 'not-a-key', alice.owner]),
    );
    expect(discovery.active).toEqual([alice.owner]);
    expect(discovery.withoutKey).toEqual([carol.owner]);
    expect(discovery.failures.map((f) => f.peer)).toEqual(['not-a-key']);
    await settle(carol.client.publishKeyRecord());
    expect((await settle(bob.client.discoverConversations([carol.owner]))).active).toEqual([]);

    // Clearing removes only the caller's own copies
    const cleared = await settle(alice.client.clearMessagesWithReport(bob.owner));
    expect(cleared.failures).toEqual([]);
    expect(cleared.deleted).toEqual([`${aliceDir}${third}.json`]);
    const after = await settle(bob.client.fetchMessages(alice.owner));
    expect(after.messages.map((m) => m.content)).toEqual(['hi alice']);
    expect(alice.client.requestStats().put.attempts).toBe(3);
  });

  it('prepared messages round-trip through JSON and are authenticated before I/O', async () => {
    const server = new FakeStorage();
    const alice = party(server, 0x11);
    const bob = party(server, 0x22);
    await settle(alice.client.publishKeyRecord());
    await settle(bob.client.publishKeyRecord());

    const prepared = await settle(alice.client.prepareMessage(bob.owner, 'durable'));
    expect(prepared.version()).toBe(2);
    expect(prepared.owner()).toBe(alice.owner);
    expect(prepared.recipient()).toBe(bob.owner);
    expect(prepared.timestamp()).toBe(1_763_000_000);
    expect(JSON.parse(decodeUtf8Strict(prepared.payload()))).toMatchObject({
      version: 2,
      timestamp: 1_763_000_000,
    });
    expect(() => prepared.validate({ messagingKey: alice.identity.publicKeyZ32() })).not.toThrow();
    expect(() => prepared.validate({ messagingKey: bob.identity.publicKeyZ32() })).toThrow(
      /authentication failed/,
    );

    const saved = JSON.stringify(prepared);
    const restored = PreparedMessage.fromJSON(JSON.parse(saved));
    const id = await settle(alice.client.publishMessage(restored));
    expect(id).toBe(prepared.id());
    expect(await settle(alice.client.publishMessage(restored))).toBe(id);
    const [aliceDir] = directories(alice, bob);
    expect(server.entries(aliceDir)).toEqual([`${aliceDir}${id}.json`]);
    expect(
      server.state.putBodies
        .filter(([url]) => url.endsWith(`${id}.json`))
        .every(([, body]) => decodeUtf8Strict(body) === decodeUtf8Strict(prepared.payload())),
    ).toBe(true);

    const puts = alice.client.requestStats().put.attempts;
    const original = prepared.toJSON();
    const tampered = { ...original, payload: [...original.payload] };
    tampered.payload[30] = tampered.payload[30] === 49 ? 50 : 49;
    for (const bad of [
      tampered,
      { ...original, recipient: Keypair.fromSecret(secret(0x33)).publicKey.z32() },
      { ...original, id: globalThis.crypto.randomUUID() },
      { ...original, version: 1 },
    ]) {
      await expect(alice.client.publishMessage(PreparedMessage.fromJSON(bad))).rejects.toThrow();
    }
    // Another identity cannot publish it, and the v1 client refuses a v2 envelope
    await expect(bob.client.publishMessage(restored)).rejects.toThrow(/another identity/);
    const v1 = new PrivateMessengerClient(alice.keypair, {
      storage: server.storageFor(alice.owner),
    });
    await expect(v1.publishMessage(restored)).rejects.toThrow(
      /Unsupported prepared message version/,
    );
    await expect(alice.client.publishMessage(v1.prepareMessage(bob.owner, 'v1'))).rejects.toThrow(
      /Unsupported prepared message version/,
    );
    expect(alice.client.requestStats().put.attempts).toBe(puts);
  });

  it('a sender that does not own the directory is a failure, a bad signature is unverified', async () => {
    const server = new FakeStorage();
    const alice = party(server, 0x11);
    const bob = party(server, 0x22);
    await settle(alice.client.publishKeyRecord());
    await settle(bob.client.publishKeyRecord());
    const id = await settle(alice.client.sendMessage(bob.owner, 'signed by alice'));
    const [aliceDir, bobDir] = directories(alice, bob);
    const body = server.body(`${aliceDir}${id}.json`);

    // Bob republishes Alice's message in his own directory
    const copied = `${bobDir}${id}.json`;
    server.reply(copied, [{ body }]);
    server.addEntry(bobDir, copied);
    // And tampers with the signature of another message he wrote
    const own = await settle(bob.client.sendMessage(alice.owner, 'tampered signature'));
    const ownUrl = `${bobDir}${own}.json`;
    const json = JSON.parse(server.body(ownUrl));
    json.signature_bytes[0] ^= 1;
    server.reply(ownUrl, [{ body: JSON.stringify(json) }]);

    const fetch = await settle(alice.client.fetchMessages(bob.owner));
    expect(fetch.messages.map((m) => [m.content, m.sender, m.verified])).toEqual([
      ['signed by alice', alice.owner, true],
      ['tampered signature', bob.owner, false],
    ]);
    expect(fetch.failures).toEqual([
      { url: copied, attempts: 1, reason: { kind: 'senderMismatch' } },
    ]);

    // Incremental receive reports it too and never delivers it
    const state = new ReceiveState();
    const received = await settle(alice.client.receiveNewMessages(bob.owner, state));
    expect(received.failures).toEqual([
      { url: copied, attempts: 1, reason: { kind: 'senderMismatch' } },
    ]);
    expect(received.messages.map((m) => m.message?.content)).toEqual([
      'signed by alice',
      'tampered signature',
    ]);
  });

  it('bodies that are not v2 messages are undecryptable, not messages', async () => {
    const server = new FakeStorage();
    const alice = party(server, 0x11);
    const bob = party(server, 0x22);
    await settle(alice.client.publishKeyRecord());
    await settle(bob.client.publishKeyRecord());
    const [, bobDir] = directories(alice, bob);
    // A v1 message between the same identities, placed in the v2 directory
    const { PrivateMessage } = await import('../../src/message');
    const v1Body = PrivateMessage.createAt(
      bob.keypair.secret(),
      alice.keypair.publicKey.toUint8Array(),
      'v1',
      1,
    ).serialize();
    const url = `${bobDir}v1.json`;
    server.reply(url, [{ body: v1Body }]);
    server.addEntry(bobDir, url);

    const fetch = await settle(alice.client.fetchMessages(bob.owner));
    expect(fetch).toEqual({ messages: [], failures: [] });
    const received = await settle(alice.client.receiveNewMessages(bob.owner, new ReceiveState()));
    expect(received.messages).toEqual([
      {
        id: { publisher: bob.owner, url },
        message: null,
        etag: expect.any(String),
        updated: false,
      },
    ]);
  });

  it('an invalid peer key record is an error, not an absent record', async () => {
    const server = new FakeStorage();
    const alice = party(server, 0x11);
    const bob = party(server, 0x22);
    // A record in Bob's storage naming Alice as its owner
    const { body } = buildKeyRecord(bob.identity, alice.owner, 1);
    server.reply(`pubky://${bob.owner}${KEY_RECORD_PATH}`, [{ body: decodeUtf8Strict(body) }]);
    await expect(settle(alice.client.fetchKeyRecord(bob.owner))).rejects.toBeInstanceOf(
      InvalidKeyRecordError,
    );
    const discovery = await settle(alice.client.discoverConversations([bob.owner]));
    expect(discovery.failures.length).toBe(1);
    expect(discovery.failures[0]!.error).toMatch(/Invalid key record/);
    await expect(settle(alice.client.fetchMessages(bob.owner))).rejects.toBeInstanceOf(
      InvalidKeyRecordError,
    );
    expect(
      () =>
        new MessengerV2Client({
          owner: `pubky${alice.owner}`,
          identity: alice.identity,
          storage: server.storageFor(alice.owner),
        }),
    ).toThrow();
  });
});

describe('protocol separation', () => {
  it('v1 and v2 directories never collide', () => {
    const alice = Keypair.fromSecret(secret(0x11));
    const bob = Keypair.fromSecret(secret(0x22));
    const v1Path = ConversationKey.derive(alice.secret(), bob.publicKey.toUint8Array()).path();
    const v2 = v2Conversation({
      identity: MessagingIdentity.fromIdentitySecret(alice.secret()),
      owner: alice.publicKey.z32(),
      peer: bob.publicKey.z32(),
      peerMessagingKey: MessagingIdentity.fromIdentitySecret(bob.secret()).publicKeyZ32(),
    });
    expect(v1Path).toMatch(/^\/pub\/private_messages\/[0-9a-f]{64}\/$/);
    expect(v2.path).toMatch(/^\/pub\/private_messages\/v2\/[0-9a-f]{64}\/$/);
    expect(v2.path.startsWith(v1Path)).toBe(false);
    expect(v1Path.startsWith(v2.path)).toBe(false);
    expect(v2.path.split('/')[4]).not.toBe(v1Path.split('/')[3]);
    const v1Dir = `pubky://${alice.publicKey.z32()}${v1Path}`;
    expect(isMessageUrl(v1Dir, `${v2.sides[0].directory}x.json`)).toBe(false);
    expect(isMessageUrl(v2.sides[0].directory, `${v1Dir}x.json`)).toBe(false);
    // The key record is in neither kind of conversation directory
    expect(
      isMessageUrl(
        `pubky://${alice.publicKey.z32()}/pub/private_messages/v2/`,
        `pubky://${alice.publicKey.z32()}${KEY_RECORD_PATH}`,
      ),
    ).toBe(true);
    expect(/^\/pub\/private_messages\/[0-9a-f]{64}\//.test(KEY_RECORD_PATH)).toBe(false);
  });

  it('the message signature binds the recipient', () => {
    const a = Keypair.fromSecret(secret(0x11)).publicKey.toUint8Array();
    const b = Keypair.fromSecret(secret(0x22)).publicKey.toUint8Array();
    const c = Keypair.fromSecret(secret(0x33)).publicKey.toUint8Array();
    expect(bytesToHex(v2MessageDigest('hi', a, b, 1))).not.toBe(
      bytesToHex(v2MessageDigest('hi', a, c, 1)),
    );
    expect(v2MessageDigest('', a, b, 0).length).toBe(32);
    expect(hexToBytes(bytesToHex(utf8('x')))).toEqual(utf8('x'));
  });
});
