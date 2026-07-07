import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { Keypair } from '@synonymdev/pubky';
import {
  ed25519PublicToX25519,
  ed25519SecretToX25519,
  generateSharedSecret,
  generateConversationPath,
} from '../../src/crypto';

describe('Ed25519 -> X25519 conversion', () => {
  it('matches noble x25519.getPublicKey (oracle for correctness vs libsodium/dalek)', () => {
    for (let i = 0; i < 25; i++) {
      const kp = Keypair.random();
      const fromPriv = x25519.getPublicKey(ed25519SecretToX25519(kp.secret()));
      const fromPub = ed25519PublicToX25519(kp.publicKey.toUint8Array());
      expect(Array.from(fromPub)).toEqual(Array.from(fromPriv));
    }
  });
});

describe('shared secret & conversation path', () => {
  it('ECDH is symmetric between the two parties', () => {
    const a = Keypair.random();
    const b = Keypair.random();
    expect(generateSharedSecret(a, b.publicKey)).toBe(generateSharedSecret(b, a.publicKey));
  });

  it('shared secret is 64 lowercase hex chars', () => {
    const a = Keypair.random();
    const b = Keypair.random();
    expect(generateSharedSecret(a, b.publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('conversation path is deterministic, symmetric, and well-formed', () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const pathAB = generateConversationPath(a, b.publicKey);
    const pathBA = generateConversationPath(b, a.publicKey);
    expect(pathAB).toBe(pathBA);
    expect(pathAB).toMatch(/^\/pub\/private_messages\/[0-9a-f]{64}\/$/);
    expect(generateConversationPath(a, b.publicKey)).toBe(pathAB);
  });
});
