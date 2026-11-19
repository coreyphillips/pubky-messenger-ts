import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import {
  concatBytes,
  decodeUtf8Strict,
  equalBytes,
  isByteArray,
  isU64,
  u64BE,
  utf8,
} from './bytes.js';
import { ConversationKey } from './crypto.js';
import { FetchFailureError, Requests, type EngineContext } from './engine.js';
import { PrivateMessage, parsePrivateMessageJson, unixSeconds } from './message.js';
import { parseZ32PublicKey } from './z32.js';

/**
 * Durable publication of one encrypted resource. Ported from `pubky-messenger` `src/prepared.rs`.
 */

const DOMAIN = utf8('pubky-messenger/prepared-message');
const FIELDS = ['version', 'id', 'owner', 'recipient', 'payload', 'signature'] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Envelope version of a v1 prepared message. */
export const PREPARED_V1 = 1;

/** JSON shape of a `PreparedMessage`, the same as the Rust crate's serde output. */
export interface PreparedMessageJson {
  version: number;
  id: string;
  owner: string;
  recipient: string;
  payload: number[];
  signature: number[];
}

interface Fields {
  version: number;
  id: string;
  owner: string;
  recipient: string;
  payload: Uint8Array;
  signature: Uint8Array;
}

/**
 * An encrypted message prepared before network I/O, suitable for a durable outbox.
 *
 * Persist `toJSON()` before publication and keep it unchanged for every retry. Its ID is a
 * transport resource identity, separate from any application request ID in the content.
 * Restored values are validated and authenticated before use. No destination URL is stored.
 */
export class PreparedMessage {
  private constructor(private readonly fields: Fields) {}

  /** @internal Sign and wrap a payload. */
  static seal(unsigned: Omit<Fields, 'signature'>, signingSecret: Uint8Array): PreparedMessage {
    const digest = preparedDigest(unsigned);
    return new PreparedMessage({ ...unsigned, signature: ed25519.sign(digest, signingSecret) });
  }

  version(): number {
    return this.fields.version;
  }

  /** The message UUID: the file name it is published under, without `.json`. */
  id(): string {
    return this.fields.id;
  }

  /** Bare z-base-32 identity key of the sender. */
  owner(): string {
    return this.fields.owner;
  }

  /** Bare z-base-32 identity key of the recipient. */
  recipient(): string {
    return this.fields.recipient;
  }

  /** The exact encrypted bytes used as the PUT body on every publication (a copy). */
  payload(): Uint8Array {
    return this.fields.payload.slice();
  }

  /** The Unix-second timestamp inside the encrypted message. Throws if the payload is not a message. */
  timestamp(): number {
    const value = JSON.parse(decodeUtf8Strict(this.fields.payload)) as { timestamp?: unknown };
    if (!isU64(value?.timestamp)) throw new Error('Invalid prepared payload');
    return value.timestamp;
  }

  /** @internal Blake3 binding of version, ID, owner, recipient and payload. */
  digest(): Uint8Array {
    return preparedDigest(this.fields);
  }

  /** @internal */
  signatureBytes(): Uint8Array {
    return this.fields.signature;
  }

  /**
   * Authenticate restored metadata and the encrypted payload shape without secrets or I/O.
   *
   * Call this before using restored IDs or participants for cleanup or other side effects.
   * Publication additionally checks the local owner and decrypts and verifies the message.
   * Throws on any problem.
   */
  validate(): void {
    if (this.fields.version !== PREPARED_V1) {
      throw new Error('Unsupported prepared message version');
    }
    const owner = this.validateEnvelope();
    this.verifyBinding(owner);
    let message: unknown;
    try {
      message = parsePrivateMessageJson(JSON.parse(decodeUtf8Strict(this.fields.payload)));
    } catch {
      throw new Error('Invalid prepared payload');
    }
    if ((message as { signature_bytes: number[] }).signature_bytes.length !== 64) {
      throw new Error('Invalid prepared message signature length');
    }
  }

  /** @internal Check participants, ID and signature length; return the owner's key bytes. */
  validateEnvelope(): Uint8Array {
    let owner: Uint8Array;
    try {
      owner = parseZ32PublicKey(this.fields.owner, 'prepared owner');
    } catch (e) {
      throw new Error(`Invalid prepared owner: ${(e as Error).message}`);
    }
    try {
      parseZ32PublicKey(this.fields.recipient, 'prepared recipient');
    } catch (e) {
      throw new Error(`Invalid prepared recipient: ${(e as Error).message}`);
    }
    if (!UUID_V4.test(this.fields.id)) {
      throw new Error('Invalid prepared message ID');
    }
    if (this.fields.signature.length !== 64) {
      throw new Error('Invalid prepared signature');
    }
    return owner;
  }

  /** @internal Verify the envelope signature under `signer`. */
  verifyBinding(signer: Uint8Array): void {
    let ok = false;
    try {
      ok = ed25519.verify(this.fields.signature, this.digest(), signer);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('Prepared message authentication failed');
  }

  /** Plain JSON object for storage, byte arrays as `number[]`. */
  toJSON(): PreparedMessageJson {
    return {
      version: this.fields.version,
      id: this.fields.id,
      owner: this.fields.owner,
      recipient: this.fields.recipient,
      payload: Array.from(this.fields.payload),
      signature: Array.from(this.fields.signature),
    };
  }

  /**
   * Restore from `toJSON()` output (or its string form). Rejects unknown or missing fields and
   * wrongly typed values; call `validate()` (publication does) to authenticate the content.
   */
  static fromJSON(json: PreparedMessageJson | string | unknown): PreparedMessage {
    const value: unknown = typeof json === 'string' ? JSON.parse(json) : json;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Invalid prepared message: expected an object');
    }
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(v)) {
      if (!(FIELDS as readonly string[]).includes(key)) {
        throw new Error(`Invalid prepared message: unknown field ${key}`);
      }
    }
    if (
      typeof v.version !== 'number' ||
      !Number.isInteger(v.version) ||
      v.version < 0 ||
      v.version > 255
    ) {
      throw new Error('Invalid prepared message: version');
    }
    for (const key of ['id', 'owner', 'recipient'] as const) {
      if (typeof v[key] !== 'string') throw new Error(`Invalid prepared message: ${key}`);
    }
    for (const key of ['payload', 'signature'] as const) {
      if (!isByteArray(v[key])) throw new Error(`Invalid prepared message: ${key}`);
    }
    return new PreparedMessage({
      version: v.version,
      id: v.id as string,
      owner: v.owner as string,
      recipient: v.recipient as string,
      payload: Uint8Array.from(v.payload as number[]),
      signature: Uint8Array.from(v.signature as number[]),
    });
  }

  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  static deserialize(json: string): PreparedMessage {
    return PreparedMessage.fromJSON(json);
  }

  /** Short description without secrets or payload bytes. */
  toString(): string {
    return `PreparedMessage { version: ${this.fields.version}, id: ${this.fields.id}, payload_bytes: ${this.fields.payload.length} }`;
  }
}

function preparedDigest(fields: Omit<Fields, 'signature'>): Uint8Array {
  const parts: Uint8Array[] = [DOMAIN, Uint8Array.of(fields.version)];
  for (const value of [
    utf8(fields.id),
    utf8(fields.owner),
    utf8(fields.recipient),
    fields.payload,
  ]) {
    parts.push(u64BE(value.length), value);
  }
  return blake3(concatBytes(...parts));
}

/** Prepare a v1 message from the identity secret to `recipient` (bare z-base-32). */
export function prepareV1(
  secretKey: Uint8Array,
  owner: string,
  recipient: string,
  content: string,
  timestamp: number = unixSeconds(),
): PreparedMessage {
  const recipientPublic = parseZ32PublicKey(recipient, 'recipient');
  const message = PrivateMessage.createAt(secretKey, recipientPublic, content, timestamp);
  return PreparedMessage.seal(
    {
      version: PREPARED_V1,
      id: PrivateMessage.generateId(),
      owner,
      recipient,
      payload: message.toBytes(),
    },
    secretKey,
  );
}

/**
 * Validate a v1 prepared message for publication by the identity `owner` and return its
 * destination URL, derived locally and never loaded from the value.
 */
export function v1Destination(
  prepared: PreparedMessage,
  secretKey: Uint8Array,
  owner: string,
): string {
  prepared.validate();
  if (prepared.owner() !== owner) {
    throw new Error('Prepared message belongs to another identity');
  }
  const key = ConversationKey.derive(secretKey, parseZ32PublicKey(prepared.recipient()));
  let sender: string;
  let content: string;
  let message: PrivateMessage;
  try {
    message = PrivateMessage.fromJSON(JSON.parse(decodeUtf8Strict(prepared.payload())));
    sender = message.decryptSenderWith(key);
    content = message.decryptContentWith(key);
  } catch {
    throw new Error('Invalid prepared payload');
  }
  if (sender !== prepared.owner() || !message.verifySignature(content, sender)) {
    throw new Error('Invalid prepared message signature');
  }
  return `pubky://${prepared.owner()}${key.path()}${prepared.id()}.json`;
}

/** Store the prepared bytes at `url`. Throws `FetchFailureError` if storage fails. */
export async function publishPrepared(
  ctx: EngineContext,
  url: string,
  prepared: PreparedMessage,
  signal?: AbortSignal,
): Promise<string> {
  const result = await new Requests(ctx, { signal }).publish(url, prepared.payload());
  if (!result.ok) throw new FetchFailureError(result.failure);
  return prepared.id();
}

/** Whether two prepared messages are the same value. */
export function samePrepared(a: PreparedMessage, b: PreparedMessage): boolean {
  return (
    a.version() === b.version() &&
    a.id() === b.id() &&
    a.owner() === b.owner() &&
    a.recipient() === b.recipient() &&
    equalBytes(a.payload(), b.payload()) &&
    equalBytes(a.signatureBytes(), b.signatureBytes())
  );
}
