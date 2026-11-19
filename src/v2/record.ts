import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { concatBytes, decodeUtf8Lossy, isByteArray, isU64, utf8 } from '../bytes.js';
import { x25519SharedSecret } from '../crypto.js';
import { parseZ32PublicKey } from '../z32.js';
import { messagingSeed, type MessagingIdentity } from './keys.js';

/**
 * Protocol v2 key records (PROTOCOL-v2.md section 3).
 */

const KEY_RECORD_DOMAIN = utf8('pubky-messenger/v2/key-record');

/** A verified key record: the messaging key an identity published. */
export interface KeyRecord {
  version: 2;
  /** Identity key `I`, bare z-base-32. */
  owner: string;
  /** Messaging key `M`, bare z-base-32. */
  messagingKey: string;
  /** Unix time in microseconds when the record was written. */
  createdAt: number;
}

/** Stored JSON of a key record, keys in this order. */
export interface KeyRecordJson {
  version: 2;
  owner: string;
  messaging_key: string;
  created_at: number;
  signature: number[];
}

/** A key record exists but does not verify. It is not treated as absent. */
export class InvalidKeyRecordError extends Error {
  constructor(message: string) {
    super(`Invalid key record: ${message}`);
    this.name = 'InvalidKeyRecordError';
  }
}

function digest(owner: Uint8Array, messagingKey: Uint8Array): Uint8Array {
  return blake3(concatBytes(KEY_RECORD_DOMAIN, owner, messagingKey));
}

/** Build and sign the key record body for `owner` (bare z-base-32 identity key). */
export function buildKeyRecord(
  identity: MessagingIdentity,
  owner: string,
  createdAt: number,
): { record: KeyRecord; body: Uint8Array } {
  const ownerRaw = parseZ32PublicKey(owner, 'owner');
  if (!isU64(createdAt)) throw new Error('createdAt must be a non-negative integer');
  const signature = ed25519.sign(
    digest(ownerRaw, identity.publicKeyBytes()),
    messagingSeed(identity),
  );
  const json: KeyRecordJson = {
    version: 2,
    owner,
    messaging_key: identity.publicKeyZ32(),
    created_at: createdAt,
    signature: Array.from(signature),
  };
  return {
    record: { version: 2, owner, messagingKey: identity.publicKeyZ32(), createdAt },
    body: utf8(JSON.stringify(json)),
  };
}

/**
 * Parse and verify a key record fetched for `expectedOwner`. Requires version 2, the expected
 * owner, a messaging key that is a usable Ed25519 point (not small order), and a signature by
 * that key. Unknown fields are ignored. Throws `InvalidKeyRecordError`.
 */
export function parseKeyRecord(body: Uint8Array | string, expectedOwner: string): KeyRecord {
  let value: unknown;
  try {
    value = JSON.parse(typeof body === 'string' ? body : decodeUtf8Lossy(body));
  } catch {
    throw new InvalidKeyRecordError('not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidKeyRecordError('expected an object');
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 2) throw new InvalidKeyRecordError('unsupported version');
  if (v.owner !== expectedOwner) throw new InvalidKeyRecordError('owner does not match');
  if (typeof v.messaging_key !== 'string') throw new InvalidKeyRecordError('messaging_key');
  if (!isU64(v.created_at)) throw new InvalidKeyRecordError('created_at');
  if (!isByteArray(v.signature) || v.signature.length !== 64) {
    throw new InvalidKeyRecordError('signature');
  }
  let ownerRaw: Uint8Array;
  let messagingRaw: Uint8Array;
  try {
    ownerRaw = parseZ32PublicKey(expectedOwner, 'owner');
    messagingRaw = parseZ32PublicKey(v.messaging_key, 'messaging key');
  } catch (e) {
    throw new InvalidKeyRecordError((e as Error).message);
  }
  if (!usableForAgreement(messagingRaw)) {
    throw new InvalidKeyRecordError('messaging key cannot be used for key agreement');
  }
  let ok = false;
  try {
    ok = ed25519.verify(Uint8Array.from(v.signature), digest(ownerRaw, messagingRaw), messagingRaw);
  } catch {
    ok = false;
  }
  if (!ok) throw new InvalidKeyRecordError('signature does not verify');
  return {
    version: 2,
    owner: expectedOwner,
    messagingKey: v.messaging_key,
    createdAt: v.created_at,
  };
}

// A small-order key gives every peer the all-zero shared secret
function usableForAgreement(publicKey: Uint8Array): boolean {
  try {
    x25519SharedSecret(new Uint8Array(32).fill(1), publicKey).fill(0);
    return true;
  } catch {
    return false;
  }
}
