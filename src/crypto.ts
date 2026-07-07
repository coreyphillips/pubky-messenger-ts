import { x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Keypair, PublicKey } from '@synonymdev/pubky';

/**
 * Key-agreement and conversation-path derivation.
 *
 * Ported from `pubky-messenger` `src/crypto.rs`. Identity keys are Ed25519
 * (pkarr `Keypair`); encryption keys are X25519 derived from them using the
 * standard libsodium/RFC-7748 conversion. The Ed25519->X25519 conversion here is
 * validated against noble's `x25519.getPublicKey` in the test suite.
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

// Modular inverse via Fermat's little theorem (P is prime): a^(P-2) mod P.
function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let b = mod(base, m);
  let result = 1n;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

function invert(a: bigint, m: bigint = P): bigint {
  return modpow(a, m - 2n, m);
}

/**
 * Convert an Ed25519 public key (32 bytes) to its X25519 public key (Montgomery `u`).
 *
 * Equivalent to curve25519-dalek's `to_montgomery()`: the birational map
 * `u = (1 + y) / (1 - y)`, where `y` is the Edwards y-coordinate encoded in the
 * compressed key (with the sign bit cleared).
 */
export function ed25519PublicToX25519(edPub: Uint8Array): Uint8Array {
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

/**
 * X25519 ECDH shared secret between `keypair` and `otherPubky`, hex-encoded.
 *
 * Returns the raw 32-byte Diffie-Hellman output as a lowercase 64-char hex string
 * (matching `generate_shared_secret` in Rust, which `hex::encode`s the DH bytes).
 */
export function generateSharedSecret(keypair: Keypair, otherPubky: PublicKey): string {
  const x25519Secret = ed25519SecretToX25519(keypair.secret());

  const otherBytes = otherPubky.toUint8Array();
  if (otherBytes.length !== 32) {
    throw new Error('Invalid public key length');
  }
  const otherX25519 = ed25519PublicToX25519(otherBytes);

  const shared = x25519.getSharedSecret(x25519Secret, otherX25519);
  return bytesToHex(shared);
}

/**
 * Deterministic, symmetric conversation path for two parties.
 *
 * `blake3(ascii_bytes_of(shared_secret_hex))` hex -> `/pub/private_messages/{id}/`.
 * Note: blake3 hashes the ASCII bytes of the hex string, not the raw DH bytes;
 * this must match Rust exactly or the two sides derive different paths.
 */
export function generateConversationPath(keypair: Keypair, otherPubky: PublicKey): string {
  const sharedSecret = generateSharedSecret(keypair, otherPubky);
  const pathId = bytesToHex(blake3(utf8ToBytes(sharedSecret)));
  return `/pub/private_messages/${pathId}/`;
}
