import { describe, it, expect } from 'vitest';
import { Keypair } from '@synonymdev/pubky';
import { PrivateMessage } from '../../src/message';

describe('PrivateMessage', () => {
  it('encrypts, decrypts, and verifies (Alice -> Bob)', () => {
    const alice = Keypair.random();
    const bob = Keypair.random();
    const content = 'Hello Bob!';

    const msg = PrivateMessage.create(alice, bob.publicKey, content);

    // Bob decrypts using the symmetric (bob, alice.pub) shared secret.
    const decryptedContent = msg.decryptContent(bob, alice.publicKey);
    const decryptedSender = msg.decryptSender(bob, alice.publicKey);

    expect(decryptedContent).toBe(content);
    expect(decryptedSender).toBe(alice.publicKey.z32());
    expect(msg.verifySignature(decryptedContent, decryptedSender)).toBe(true);
  });

  it('the sender can also decrypt their own copy', () => {
    const alice = Keypair.random();
    const bob = Keypair.random();
    const msg = PrivateMessage.create(alice, bob.publicKey, 'hi');
    expect(msg.decryptContent(alice, bob.publicKey)).toBe('hi');
  });

  it('does not verify when the content is altered', () => {
    const alice = Keypair.random();
    const bob = Keypair.random();
    const msg = PrivateMessage.create(alice, bob.publicKey, 'hi');
    const sender = msg.decryptSender(bob, alice.publicKey);
    expect(msg.verifySignature('tampered', sender)).toBe(false);
  });

  it('uses a snake_case number[] JSON wire format (Rust-compatible)', () => {
    const alice = Keypair.random();
    const bob = Keypair.random();
    const msg = PrivateMessage.create(alice, bob.publicKey, 'wire format');

    const obj = JSON.parse(msg.serialize());
    expect(typeof obj.timestamp).toBe('number');
    expect(Array.isArray(obj.encrypted_sender)).toBe(true);
    expect(Array.isArray(obj.encrypted_content)).toBe(true);
    expect(Array.isArray(obj.signature_bytes)).toBe(true);
    expect(obj.signature_bytes.length).toBe(64);
    expect(
      (obj.encrypted_content as number[]).every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
    ).toBe(true);

    // Survives a serialize -> deserialize round trip.
    const restored = PrivateMessage.deserialize(msg.serialize());
    expect(restored.decryptContent(bob, alice.publicKey)).toBe('wire format');
  });

  it('generateId returns unique 36-char UUIDs', () => {
    const id1 = PrivateMessage.generateId();
    const id2 = PrivateMessage.generateId();
    expect(id1).not.toBe(id2);
    expect(id1.length).toBe(36);
    expect(id2.length).toBe(36);
  });
});
