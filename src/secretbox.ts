import { xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { randomBytes } from '@noble/hashes/utils.js';

/**
 * XSalsa20-Poly1305 (NaCl `secretbox`) authenticated encryption.
 *
 * This mirrors `pubky_common::crypto::{encrypt, decrypt}` byte for byte so that messages are
 * wire-compatible with the Rust `pubky-messenger` implementation:
 *   - a fresh random 24-byte nonce is generated per field and prepended:
 *     `nonce(24) || tag(16) || ciphertext`;
 *   - empty plaintext encrypts to empty output (and decrypts back to empty);
 *   - inputs shorter than the nonce are rejected.
 */

export const NONCE_LENGTH = 24;

/** Encrypt `plaintext` with a 32-byte key. Returns `nonce || tag || ciphertext`. */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  return encryptWithNonce(plaintext, key, randomBytes(NONCE_LENGTH));
}

/**
 * Encrypt with a caller-chosen nonce. Only for reproducing known vectors in tests: reusing a
 * nonce with the same key breaks confidentiality.
 */
export function encryptWithNonce(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  if (plaintext.length === 0) {
    return new Uint8Array(0);
  }
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Nonce must be ${NONCE_LENGTH} bytes`);
  }
  const ciphertext = xsalsa20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/** Decrypt `nonce || tag || ciphertext` with a 32-byte key. Throws on failure. */
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
