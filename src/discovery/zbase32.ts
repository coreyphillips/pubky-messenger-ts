// z-base-32 (Zooko's) encoding, as used by pkarr/pubky for public keys.
// Verified to match `PublicKey.z32()`.

const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/** Encode bytes to a z-base-32 string (32 bytes -> the 52-char pubky form). */
export function zbase32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i]!;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}
