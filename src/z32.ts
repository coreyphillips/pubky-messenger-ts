import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * z-base-32 encoding of 32-byte public keys, without WASM, so keys can be validated and
 * compared anywhere in the library.
 */

const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const LOOKUP = new Map<string, number>([...ALPHABET].map((ch, i) => [ch, i]));

/** Encode bytes as z-base-32 (no padding), the way pkarr renders a public key. */
export function z32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decode z-base-32, or return null if a character is outside the alphabet. */
export function z32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = LOOKUP.get(ch);
    if (value === undefined) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/** Whether `bytes` decode to a point on the Ed25519 curve. */
export function isEd25519Point(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  try {
    // zip215 accepts the same encodings ed25519-dalek's `VerifyingKey::from_bytes` does
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a bare, canonical 52-character z-base-32 Ed25519 public key.
 *
 * Throws unless re-encoding the 32 bytes gives back `text` exactly and they name a curve point.
 */
export function parseZ32PublicKey(text: string, what = 'public key'): Uint8Array {
  if (typeof text !== 'string' || text.length !== 52) {
    throw new Error(`Invalid ${what}: expected a bare 52-character z-base-32 key`);
  }
  const bytes = z32Decode(text);
  if (!bytes || bytes.length !== 32 || z32Encode(bytes) !== text) {
    throw new Error(`Invalid ${what}: not canonical z-base-32`);
  }
  if (!isEd25519Point(bytes)) {
    throw new Error(`Invalid ${what}: not an Ed25519 public key`);
  }
  return bytes;
}

/** Whether `text` is a bare, canonical z-base-32 Ed25519 public key. */
export function isZ32PublicKey(text: unknown): text is string {
  try {
    parseZ32PublicKey(text as string);
    return true;
  } catch {
    return false;
  }
}
