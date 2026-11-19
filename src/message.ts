import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import type { Keypair, PublicKey } from '@synonymdev/pubky';
import {
  concatBytes,
  decodeUtf8Lossy,
  decodeUtf8Strict,
  isByteArray,
  isU64,
  u64BE,
  utf8,
} from './bytes.js';
import { ConversationKey } from './crypto.js';
import { encrypt, decrypt } from './secretbox.js';
import { isEd25519Point, z32Decode, z32Encode } from './z32.js';

/** A decrypted message ready for application use. */
export interface DecryptedMessage {
  /** Bare z-base-32 public key of the sender. */
  sender: string;
  content: string;
  /** Unix seconds, as written by the sender. */
  timestamp: number;
  /** Whether the Ed25519 signature verified. */
  verified: boolean;
}

/**
 * On-the-wire JSON shape of a stored v1 message.
 *
 * Field names are snake_case and byte arrays are arrays of numbers, byte-compatible with the
 * Rust `serde_json` representation. Keys appear in this order when serialized.
 */
export interface PrivateMessageJson {
  timestamp: number;
  encrypted_sender: number[];
  encrypted_content: number[];
  signature_bytes: number[];
}

/** Current Unix time in whole seconds. */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse a public key the way pkarr's `PublicKey::from_str` does: a bare z-base-32 key, or one
 * inside a URL-like string (`pk:`, `https://`, ...). Returns null if it is not a curve point.
 */
export function parsePublicKeyLoose(value: string): Uint8Array | null {
  let s = value;
  if (s.length > 52) s = splitOnce(s, ':')?.[1] ?? s;
  if (s.length > 52) s = s.startsWith('//') ? s.slice(2) : s;
  if (s.length > 52) s = splitOnce(s, '@')?.[1] ?? s;
  if (s.length > 52) s = splitOnce(s, ':')?.[0] ?? s;
  if (s.length > 52) s = splitOnce(s, '/')?.[0] ?? s;
  if (s.length > 52) s = splitOnce(s, '?')?.[0] ?? s;
  if (s.length > 52) s = splitOnce(s, '#')?.[0] ?? s;
  if (s.length > 52) {
    if (s.endsWith('.')) s = s.replace(/^\.+|\.+$/g, '');
    const dot = s.lastIndexOf('.');
    if (dot >= 0) s = s.slice(dot + 1);
  }
  const bytes = z32Decode(s);
  if (!bytes || bytes.length !== 32 || !isEd25519Point(bytes)) return null;
  return bytes;
}

function splitOnce(s: string, sep: string): [string, string] | null {
  const i = s.indexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Validate a parsed JSON value as a v1 message, as serde would deserialize it. */
export function parsePrivateMessageJson(value: unknown): PrivateMessageJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid message: expected a JSON object');
  }
  const v = value as Record<string, unknown>;
  if (!isU64(v.timestamp)) throw new Error('Invalid message: timestamp');
  for (const field of ['encrypted_sender', 'encrypted_content', 'signature_bytes'] as const) {
    if (!isByteArray(v[field])) throw new Error(`Invalid message: ${field}`);
  }
  return {
    timestamp: v.timestamp,
    encrypted_sender: v.encrypted_sender as number[],
    encrypted_content: v.encrypted_content as number[],
    signature_bytes: v.signature_bytes as number[],
  };
}

/**
 * An end-to-end encrypted v1 private message.
 *
 * Ported from `pubky-messenger` `src/message.rs`. Content and sender are encrypted with the
 * conversation key; the message is signed over `blake3(content || sender_pubkey || timestamp_be)`.
 */
export class PrivateMessage {
  constructor(
    public readonly timestamp: number,
    public readonly encryptedSender: Uint8Array,
    public readonly encryptedContent: Uint8Array,
    public readonly signatureBytes: Uint8Array,
  ) {}

  /** Create a new encrypted, signed message from `senderKeypair` to `recipientPk`. */
  static create(senderKeypair: Keypair, recipientPk: PublicKey, content: string): PrivateMessage {
    return PrivateMessage.createAt(
      senderKeypair.secret(),
      recipientPk.toUint8Array(),
      content,
      unixSeconds(),
    );
  }

  /** Create a message with an explicit timestamp from raw 32-byte keys. */
  static createAt(
    senderSecret: Uint8Array,
    recipientPublic: Uint8Array,
    content: string,
    timestamp: number,
  ): PrivateMessage {
    const senderPublic = ed25519.getPublicKey(senderSecret);
    const contentBytes = utf8(content);
    const digest = blake3(concatBytes(contentBytes, senderPublic, u64BE(timestamp)));
    const signatureBytes = ed25519.sign(digest, senderSecret);

    const key = ConversationKey.derive(senderSecret, recipientPublic).encryptionKey();
    const encryptedContent = encrypt(contentBytes, key);
    // The sender is the bare z-base-32 key, never the `pubky`-prefixed display form
    const encryptedSender = encrypt(utf8(z32Encode(senderPublic)), key);

    return new PrivateMessage(timestamp, encryptedSender, encryptedContent, signatureBytes);
  }

  /** Decrypt the message content. */
  decryptContent(receiverKeypair: Keypair, otherParticipant: PublicKey): string {
    return this.decryptContentWith(
      ConversationKey.derive(receiverKeypair.secret(), otherParticipant.toUint8Array()),
    );
  }

  /** Decrypt the sender's public key (bare z-base-32 string). */
  decryptSender(receiverKeypair: Keypair, otherParticipant: PublicKey): string {
    return this.decryptSenderWith(
      ConversationKey.derive(receiverKeypair.secret(), otherParticipant.toUint8Array()),
    );
  }

  /** Decrypt the content with an already derived key. Invalid UTF-8 throws. */
  decryptContentWith(key: ConversationKey): string {
    return decodeUtf8Strict(decrypt(this.encryptedContent, key.encryptionKey()));
  }

  /** Decrypt the sender with an already derived key. Invalid UTF-8 throws. */
  decryptSenderWith(key: ConversationKey): string {
    return decodeUtf8Strict(decrypt(this.encryptedSender, key.encryptionKey()));
  }

  /**
   * Verify the signature against the decrypted content and sender.
   *
   * Throws if the sender is not a public key or the signature length is wrong; returns `false`
   * for a well-formed but invalid signature (the Rust semantics).
   */
  verifySignature(decryptedContent: string, decryptedSender: string): boolean {
    const senderPk = parsePublicKeyLoose(decryptedSender);
    if (!senderPk) {
      throw new Error('Invalid sender public key');
    }
    const digest = blake3(concatBytes(utf8(decryptedContent), senderPk, u64BE(this.timestamp)));
    if (this.signatureBytes.length !== 64) {
      throw new Error('Invalid signature length');
    }
    try {
      return ed25519.verify(this.signatureBytes, digest, senderPk);
    } catch {
      return false;
    }
  }

  /** Generate a unique message ID (UUID v4). */
  static generateId(): string {
    return globalThis.crypto.randomUUID();
  }

  /** Convert to the on-the-wire JSON object (byte arrays as `number[]`). */
  toJSON(): PrivateMessageJson {
    return {
      timestamp: this.timestamp,
      encrypted_sender: Array.from(this.encryptedSender),
      encrypted_content: Array.from(this.encryptedContent),
      signature_bytes: Array.from(this.signatureBytes),
    };
  }

  /** Parse and validate the on-the-wire JSON object. */
  static fromJSON(obj: unknown): PrivateMessage {
    const json = parsePrivateMessageJson(obj);
    return new PrivateMessage(
      json.timestamp,
      Uint8Array.from(json.encrypted_sender),
      Uint8Array.from(json.encrypted_content),
      Uint8Array.from(json.signature_bytes),
    );
  }

  /** Serialize to compact JSON, byte-identical to Rust's `serde_json::to_string`. */
  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Deserialize from a stored JSON string. */
  static deserialize(json: string): PrivateMessage {
    return PrivateMessage.fromJSON(JSON.parse(json));
  }

  /** Serialized UTF-8 bytes, the exact body stored for this message. */
  toBytes(): Uint8Array {
    return utf8(this.serialize());
  }
}

/**
 * Decode a stored v1 body with the conversation key, or return null if it is not a message the
 * key can decrypt. A signature that does not verify yields `verified: false`.
 */
export function decodeV1Message(body: Uint8Array, key: ConversationKey): DecryptedMessage | null {
  let message: PrivateMessage;
  let content: string;
  let sender: string;
  try {
    message = PrivateMessage.fromJSON(JSON.parse(decodeUtf8Lossy(body)));
    content = message.decryptContentWith(key);
    sender = message.decryptSenderWith(key);
  } catch {
    return null;
  }
  let verified = false;
  try {
    verified = message.verifySignature(content, sender);
  } catch {
    verified = false;
  }
  return { sender, content, timestamp: message.timestamp, verified };
}
