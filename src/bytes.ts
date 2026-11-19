/**
 * Byte and text helpers shared by the wire formats. Browser and Node 18+ safe: no Buffer.
 */

const encoder = new TextEncoder();
// `ignoreBOM: true` keeps a leading U+FEFF in the output, as Rust's `String::from_utf8` does.
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lossyDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decode UTF-8, throwing on any invalid sequence (Rust `String::from_utf8`). */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return strictDecoder.decode(bytes);
}

/** Decode UTF-8, replacing invalid sequences (Rust `String::from_utf8_lossy`). */
export function decodeUtf8Lossy(bytes: Uint8Array): string {
  return lossyDecoder.decode(bytes);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Big-endian 8-byte encoding of a non-negative safe integer, as Rust's `u64::to_be_bytes`. */
export function u64BE(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Not a u64 value: ${value}`);
  }
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Whether `value` is an array of integers in 0..=255, the serde encoding of `Vec<u8>`. */
export function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

/** Whether `value` is an integer a JSON `u64` field can hold without losing precision. */
export function isU64(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Compare two strings by Unicode code point, which is the order of their UTF-8 bytes and so
 * the order Rust uses for `String`. Plain `<` compares UTF-16 code units instead.
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) {
      return x.done === y.done ? 0 : x.done ? -1 : 1;
    }
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Unreserved URI characters: ASCII letters, digits, `-`, `.`, `_` and `~`. */
export function isUnreservedName(name: string): boolean {
  return /^[A-Za-z0-9\-._~]+$/.test(name);
}

/** Percent-encode everything except unreserved characters, as homeserver cursors expect. */
export function percentEncode(value: string): string {
  let out = '';
  for (const byte of utf8(value)) {
    const ch = String.fromCharCode(byte);
    out += isUnreservedName(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
