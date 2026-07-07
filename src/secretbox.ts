import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { randomBytes } from '@noble/hashes/utils.js';

/**
 * XSalsa20-Poly1305 (NaCl `secretbox`) authenticated encryption.
 *
 * This mirrors `pubky_common::crypto::{encrypt, decrypt}` byte-for-byte so that
 * messages are wire-compatible with the Rust `pubky-messenger` implementation:
 *   - a fresh random 24-byte nonce is generated per message and prepended to the
 *     ciphertext (`[nonce(24)][ciphertext + 16-byte Poly1305 tag]`);
 *   - empty plaintext encrypts to empty output (and decrypts back to empty);
 *   - inputs shorter than the nonce length are rejected.
 *
 * Note: the Rust docs (README / architecture.md) claim ChaCha20-Poly1305, but the
 * actual `pubky-common` cipher is XSalsa20-Poly1305, verified against source.
 */

const NONCE_LENGTH = 24;

/** Encrypt `plaintext` with a 32-byte key. Returns `nonce || ciphertext`. */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (plaintext.length === 0) {
    return new Uint8Array(0);
  }
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = xsalsa20poly1305(key, nonce).encrypt(plaintext);

  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/** Decrypt `nonce || ciphertext` with a 32-byte key. Throws on failure. */
export function decrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    return new Uint8Array(0);
  }
  if (bytes.length < NONCE_LENGTH) {
    throw new Error(
      `Encrypted message too small, expected at least ${NONCE_LENGTH} bytes nonce, received ${bytes.length} bytes`,
    );
  }
  const nonce = bytes.subarray(0, NONCE_LENGTH);
  const ciphertext = bytes.subarray(NONCE_LENGTH);
  return xsalsa20poly1305(key, nonce).decrypt(ciphertext);
}
