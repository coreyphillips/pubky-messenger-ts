import { x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Keypair, PublicKey } from '@synonymdev/pubky';
import { isEd25519Point } from './z32.js';

/**
 * Key agreement and conversation path derivation.
 *
 * Ported from `pubky-messenger` `src/crypto.rs`. Identity keys are Ed25519; encryption keys are
 * X25519 derived from them with the standard libsodium/RFC 7748 conversion.
 */

// Curve25519 field prime: 2^255 - 19.
const P = 2n ** 255n - 19n;

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    n |= BigInt(bytes[i]!) << (8n * BigInt(i));
  }
  return n;
}

function numberToBytesLE(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// Modular inverse via Fermat's little theorem; like curve25519-dalek, the inverse of 0 is 0.
function invert(a: bigint): bigint {
  let b = mod(a);
  let result = 1n;
  let e = P - 2n;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

/**
 * Convert an Ed25519 public key (32 bytes) to its X25519 public key (Montgomery `u`).
 *
 * Equivalent to curve25519-dalek's `decompress()` followed by `to_montgomery()`: the key must
 * decode to a curve point, then `u = (1 + y) / (1 - y)`.
 */
export function ed25519PublicToX25519(edPub: Uint8Array): Uint8Array {
  if (!isEd25519Point(edPub)) {
    throw new Error('Failed to convert pubky to X25519');
  }
  const y = mod(bytesToNumberLE(edPub) & ((1n << 255n) - 1n));
  const u = mod((1n + y) * invert(mod(1n - y)));
  return numberToBytesLE(u, 32);
}

/**
 * Convert an Ed25519 secret key (32-byte seed) to its X25519 secret scalar.
 *
 * SHA-512 of the seed, take the low 32 bytes, then apply RFC 7748 clamping.
 */
export function ed25519SecretToX25519(edSecret: Uint8Array): Uint8Array {
  const hash = sha512(edSecret).slice(0, 32);
  hash[0] = hash[0]! & 248;
  hash[31] = (hash[31]! & 127) | 64;
  return hash;
}

const WEAK_KEY = 'Public key is a weak key and cannot be used for encryption';

/**
 * X25519 shared secret between an Ed25519 secret key and another Ed25519 public key.
 *
 * Rejects keys whose Diffie-Hellman output is all zero (small-order points), which would make the
 * secret public, like x25519-dalek's `was_contributory` check in the Rust crate.
 */
export function x25519SharedSecret(secretKey: Uint8Array, otherPublicKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) {
    throw new Error('Invalid secret key length');
  }
  if (otherPublicKey.length !== 32) {
    throw new Error('Invalid public key length');
  }
  const otherX25519 = ed25519PublicToX25519(otherPublicKey);
  const scalar = ed25519SecretToX25519(secretKey);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(scalar, otherX25519);
  } catch {
    throw new Error(WEAK_KEY);
  } finally {
    scalar.fill(0);
  }
  if (shared.every((b) => b === 0)) {
    throw new Error(WEAK_KEY);
  }
  return shared;
}

/** `lowercase_hex(blake3(lowercase_hex(shared)))`: hashes the 64 ASCII hex characters. */
export function conversationId(shared: Uint8Array): string {
  return bytesToHex(blake3(utf8ToBytes(bytesToHex(shared))));
}

/**
 * Shared secret of a two-party conversation: the encryption key for every message in it, and
 * the source of its storage path. Derive it per operation rather than caching it.
 */
export class ConversationKey {
  private constructor(private readonly secret: Uint8Array) {}

  /** Derive the key both participants compute for the conversation between them. */
  static derive(secretKey: Uint8Array, otherPublicKey: Uint8Array): ConversationKey {
    return new ConversationKey(x25519SharedSecret(secretKey, otherPublicKey));
  }

  /** Key for encrypting and decrypting message content and sender. */
  encryptionKey(): Uint8Array {
    return this.secret;
  }

  /** Deterministic v1 conversation directory, relative to either participant's root. */
  path(): string {
    // Existing conversations live under the hash of the hex-encoded secret
    return `/pub/private_messages/${conversationId(this.secret)}/`;
  }
}

/**
 * X25519 shared secret between `keypair` and `otherPubky`, hex-encoded.
 *
 * Returns the raw 32-byte Diffie-Hellman output as lowercase hex. Throws for small-order keys.
 */
export function generateSharedSecret(keypair: Keypair, otherPubky: PublicKey): string {
  return bytesToHex(x25519SharedSecret(keypair.secret(), otherPubky.toUint8Array()));
}

/**
 * Deterministic, symmetric v1 conversation path for two parties:
 * `/pub/private_messages/{blake3(hex(shared))}/`.
 */
export function generateConversationPath(keypair: Keypair, otherPubky: PublicKey): string {
  return ConversationKey.derive(keypair.secret(), otherPubky.toUint8Array()).path();
}
