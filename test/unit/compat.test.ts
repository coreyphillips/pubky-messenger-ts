import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Keypair, PublicKey } from '@synonymdev/pubky';
import { concatBytes, u64BE, utf8 } from '../../src/bytes';
import { ConversationKey, x25519SharedSecret } from '../../src/crypto';
import { receiveMessages, v1Conversation } from '../../src/conversation';
import { createEngine } from '../../src/engine';
import { PrivateMessage, decodeV1Message, type PrivateMessageJson } from '../../src/message';
import { encryptWithNonce } from '../../src/secretbox';
import { FakeStorage, settle } from '../support/fake-storage';

interface Fixture {
  alice_secret_key: string;
  bob_secret_key: string;
  conversation_path: string;
  messages: Array<{ author: 'alice' | 'bob'; content: string; message: PrivateMessageJson }>;
}

const fixturePath = fileURLToPath(new URL('../fixtures/conversation_v0_3_0.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const ALICE_Z32 = '4bfmrcuwfq4ksqoupn6wcfxrh5enr1izdeyszmhfrntuf1mzoh5o';
const BOB_Z32 = 'wnpkm7d4c7caym93kzhpamjkn11hu8jdz4m9o3y1x9huopniwuay';

const alice = Keypair.fromSecret(hexToBytes(fixture.alice_secret_key));
const bob = Keypair.fromSecret(hexToBytes(fixture.bob_secret_key));
const keyOf = { alice, bob };

describe('compatibility with messages written by pubky-messenger 0.3.0', () => {
  it('uses the identities and conversation path in the fixture', () => {
    expect(fixture.alice_secret_key).toBe('11'.repeat(32));
    expect(fixture.bob_secret_key).toBe('22'.repeat(32));
    expect(alice.publicKey.z32()).toBe(ALICE_Z32);
    expect(bob.publicKey.z32()).toBe(BOB_Z32);
    expect(ConversationKey.derive(alice.secret(), bob.publicKey.toUint8Array()).path()).toBe(
      fixture.conversation_path,
    );
    expect(ConversationKey.derive(bob.secret(), alice.publicKey.toUint8Array()).path()).toBe(
      fixture.conversation_path,
    );
  });

  it('hashes the hex text of the shared secret, not its raw bytes', () => {
    const shared = x25519SharedSecret(alice.secret(), bob.publicKey.toUint8Array());
    const id = fixture.conversation_path.split('/')[3]!;
    const overRawBytes = bytesToHex(blake3(shared));
    expect(overRawBytes.startsWith('9a0a5858')).toBe(true);
    expect(overRawBytes).not.toBe(id);
    expect(bytesToHex(blake3(utf8(bytesToHex(shared))))).toBe(id);
  });

  it('decrypts both messages from both sides with bare z-base-32 senders', () => {
    const key = ConversationKey.derive(alice.secret(), bob.publicKey.toUint8Array());
    const reverse = ConversationKey.derive(bob.secret(), alice.publicKey.toUint8Array());
    for (const entry of fixture.messages) {
      const body = utf8(JSON.stringify(entry.message));
      for (const k of [key, reverse]) {
        const decoded = decodeV1Message(body, k);
        expect(decoded).toEqual({
          sender: entry.author === 'alice' ? ALICE_Z32 : BOB_Z32,
          content: entry.content,
          timestamp: entry.message.timestamp,
          verified: true,
        });
      }
      const message = PrivateMessage.fromJSON(entry.message);
      expect(message.decryptContent(bob, alice.publicKey)).toBe(entry.content);
      expect(message.decryptSender(alice, bob.publicKey)).toBe(
        entry.author === 'alice' ? ALICE_Z32 : BOB_Z32,
      );
    }
  });

  it('re-signing reproduces the exact signature bytes', () => {
    for (const entry of fixture.messages) {
      const author = keyOf[entry.author];
      const digest = blake3(
        concatBytes(
          utf8(entry.content),
          author.publicKey.toUint8Array(),
          u64BE(entry.message.timestamp),
        ),
      );
      expect(Array.from(ed25519.sign(digest, author.secret()))).toEqual(
        entry.message.signature_bytes,
      );
    }
  });

  it('re-encrypting with the stored nonces reproduces the exact ciphertexts', () => {
    const key = ConversationKey.derive(
      alice.secret(),
      bob.publicKey.toUint8Array(),
    ).encryptionKey();
    for (const entry of fixture.messages) {
      const author = keyOf[entry.author];
      const { encrypted_content, encrypted_sender } = entry.message;
      const content = encryptWithNonce(
        utf8(entry.content),
        key,
        Uint8Array.from(encrypted_content.slice(0, 24)),
      );
      const sender = encryptWithNonce(
        utf8(author.publicKey.z32()),
        key,
        Uint8Array.from(encrypted_sender.slice(0, 24)),
      );
      expect(Array.from(content)).toEqual(encrypted_content);
      expect(Array.from(sender)).toEqual(encrypted_sender);
    }
  });

  it('serializes to the exact body bytes, keys in struct order', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    for (const entry of fixture.messages) {
      const body = PrivateMessage.fromJSON(entry.message).serialize();
      expect(Object.keys(JSON.parse(body))).toEqual([
        'timestamp',
        'encrypted_sender',
        'encrypted_content',
        'signature_bytes',
      ]);
      expect(body).toBe(JSON.stringify(entry.message));
      // The compact form of the object as it appears in the fixture file
      expect(raw.replace(/\s+/g, '')).toContain(body.replace(/\s+/g, ''));
    }
  });

  it('messages decrypt from the same path through the engine', async () => {
    vi.useFakeTimers();
    const server = new FakeStorage();
    const expected: Array<[string, string]> = [];
    fixture.messages.forEach((entry, i) => {
      const author = keyOf[entry.author];
      const directory = `pubky://${author.publicKey.z32()}${fixture.conversation_path}`;
      const url = `${directory}${i}.json`;
      server.addEntry(directory, url);
      server.reply(url, [{ body: JSON.stringify(entry.message) }]);
      expected.push([author.publicKey.z32(), entry.content]);
    });
    for (const [reader, other] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const ctx = createEngine(server.storageFor(reader.publicKey.z32()));
      const conv = v1Conversation(
        reader.secret(),
        reader.publicKey.z32(),
        other.publicKey.z32(),
        other.publicKey.toUint8Array(),
      );
      const fetch = await settle(receiveMessages(ctx, conv));
      expect(fetch.failures).toEqual([]);
      expect(fetch.messages.every((m) => m.verified)).toBe(true);
      expect(fetch.messages.map((m) => [m.sender, m.content]).sort()).toEqual([...expected].sort());
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Canonical encodings of the eight Ed25519 torsion points (crypto.rs tests). */
const SMALL_ORDER_KEYS = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
];

describe('small-order keys', () => {
  it('are rejected by conversation key derivation', () => {
    const sender = Keypair.random();
    for (const encoded of SMALL_ORDER_KEYS) {
      const bytes = hexToBytes(encoded);
      // They are valid curve points, so only the contributory check stops them
      expect(() => ed25519.Point.fromBytes(bytes, true)).not.toThrow();
      expect(ed25519.Point.fromBytes(bytes, true).isSmallOrder()).toBe(true);
      expect(() => ConversationKey.derive(sender.secret(), bytes), encoded).toThrow(/weak key/);
    }
  });

  it('cannot be messaged', () => {
    const sender = Keypair.random();
    const identity = PublicKey.from('yryyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy');
    expect(() => PrivateMessage.create(sender, identity, 'public secret')).toThrow();
  });
});
