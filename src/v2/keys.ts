import { ed25519 } from '@noble/curves/ed25519.js';
import { expand, hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8 } from '../bytes.js';
import { z32Encode } from '../z32.js';

/**
 * Protocol v2 messaging keys (PROTOCOL-v2.md sections 1 and 2).
 */

/** Storage path whose file-content key is the messaging seed. */
export const MESSAGING_KEY_PATH = '/priv/private_messages/v2/messaging-key';
/** Where each participant publishes its key record. */
export const KEY_RECORD_PATH = '/pub/private_messages/v2/key.json';
/** Capabilities a grant needs for v2 messaging: writes to the message tree and the seed. */
export const MESSAGING_CAPABILITIES =
  '/pub/private_messages/:rw,/priv/private_messages/v2/messaging-key:e';

const ROOT_INFO = utf8('pubky/hierarchical-keys/v1/root');
const DIRECTORY_INFO = utf8('pubky/hierarchical-keys/v1/directory');
const FILE_INFO = utf8('pubky/hierarchical-keys/v1/file-content');

/**
 * The pubky hierarchical keys v1 file-content key for `path`, derived from the identity secret
 * the way pubky-common 0.17.1 `encryption_keys.rs` does from the root scope: HKDF-SHA-256 with
 * no salt for the root, then one HKDF-Expand per segment, with the parent key as the PRK and
 * `label || 0x00 || segment` as info. Directory segments use the directory label; the final
 * file name uses the file-content label.
 */
export function deriveFileContentKey(identitySecret: Uint8Array, path: string): Uint8Array {
  if (!(identitySecret instanceof Uint8Array) || identitySecret.length !== 32) {
    throw new Error('Identity secret must be 32 bytes');
  }
  if (!path.startsWith('/') || path.endsWith('/')) {
    throw new Error('A file content key needs an absolute file path');
  }
  const segments = path.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\')) {
      throw new Error(`Not a canonical storage path: ${path}`);
    }
  }
  let key = hkdf(sha256, identitySecret, undefined, ROOT_INFO, 32);
  segments.forEach((segment, i) => {
    const label = i === segments.length - 1 ? FILE_INFO : DIRECTORY_INFO;
    const child = expand(sha256, key, concatBytes(label, Uint8Array.of(0), utf8(segment)), 32);
    key.fill(0);
    key = child;
  });
  return key;
}

/**
 * The v2 messaging seed for an identity secret: its file-content key for `MESSAGING_KEY_PATH`.
 * Equal to `session.grant.encryptionKeys.deriveForPath(MESSAGING_KEY_PATH)` from a grant that
 * approved `MESSAGING_KEY_PATH:e`. The caller owns the returned bytes and should zero them.
 */
export function deriveMessagingSeed(identitySecret: Uint8Array): Uint8Array {
  return deriveFileContentKey(identitySecret, MESSAGING_KEY_PATH);
}

const seeds = new WeakMap<MessagingIdentity, Uint8Array>();

/**
 * The v2 messaging keypair: the Ed25519 keypair whose secret key is the messaging seed.
 */
export class MessagingIdentity {
  private readonly publicBytes: Uint8Array;
  private readonly publicZ32: string;

  private constructor(seed: Uint8Array) {
    seeds.set(this, seed);
    this.publicBytes = ed25519.getPublicKey(seed);
    this.publicZ32 = z32Encode(this.publicBytes);
  }

  /** Copies the 32-byte seed; the caller may zero its own copy afterwards. */
  static fromSeed(seed: Uint8Array): MessagingIdentity {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) {
      throw new Error('Messaging seed must be 32 bytes');
    }
    return new MessagingIdentity(Uint8Array.from(seed));
  }

  /** Derive the seed from an identity secret locally (for holders of the identity secret). */
  static fromIdentitySecret(identitySecret: Uint8Array): MessagingIdentity {
    const seed = deriveMessagingSeed(identitySecret);
    try {
      return MessagingIdentity.fromSeed(seed);
    } finally {
      seed.fill(0);
    }
  }

  /** The messaging public key `M`, bare z-base-32. */
  publicKeyZ32(): string {
    return this.publicZ32;
  }

  /** The messaging public key `M`, 32 raw bytes (a copy). */
  publicKeyBytes(): Uint8Array {
    return this.publicBytes.slice();
  }

  /** Whether `dispose()` has been called. */
  get disposed(): boolean {
    return !seeds.has(this);
  }

  /** Zero the secret seed. Signing and decryption fail afterwards. */
  dispose(): void {
    seeds.get(this)?.fill(0);
    seeds.delete(this);
  }
}

/** @internal The seed of a live identity. */
export function messagingSeed(identity: MessagingIdentity): Uint8Array {
  const seed = seeds.get(identity);
  if (!seed) throw new Error('Messaging identity has been disposed');
  return seed;
}
