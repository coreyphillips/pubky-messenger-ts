import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { encrypt, decrypt } from '../../src/secretbox';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('secretbox (XSalsa20-Poly1305)', () => {
  const key = randomBytes(32);

  it('round-trips and prepends a 24-byte nonce (+16-byte tag)', () => {
    const msg = enc.encode('Hello Bob! 🔐');
    const box = encrypt(msg, key);
    expect(box.length).toBe(24 + msg.length + 16);
    expect(dec.decode(decrypt(box, key))).toBe('Hello Bob! 🔐');
  });

  it('empty plaintext -> empty output (and back)', () => {
    expect(encrypt(new Uint8Array(0), key).length).toBe(0);
    expect(decrypt(new Uint8Array(0), key).length).toBe(0);
  });

  it('rejects ciphertext shorter than the nonce', () => {
    expect(() => decrypt(new Uint8Array(10), key)).toThrow();
  });

  it('fails authentication when the ciphertext is tampered', () => {
    const box = encrypt(enc.encode('secret'), key);
    box[box.length - 1] = box[box.length - 1]! ^ 0xff;
    expect(() => decrypt(box, key)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const box = encrypt(enc.encode('secret'), key);
    expect(() => decrypt(box, randomBytes(32))).toThrow();
  });
});
