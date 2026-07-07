import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Keypair, PublicKey } from '@synonymdev/pubky';
import { generateSharedSecret } from './crypto.js';
import { encrypt, decrypt } from './secretbox.js';

/** A decrypted message ready for application use. */
export interface DecryptedMessage {
  sender: string;
  content: string;
  timestamp: number;
  verified: boolean;
}

/**
 * On-the-wire JSON shape of a stored message.
 *
 * Field names are snake_case and byte arrays are serialized as arrays of numbers
 * (`number[]`) to stay byte-compatible with the Rust `serde_json` representation.
 */
export interface PrivateMessageJson {
  timestamp: number;
  encrypted_sender: number[];
  encrypted_content: number[];
  signature_bytes: number[];
}

const textDecoder = new TextDecoder();

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Big-endian 8-byte encoding of a u64, matching Rust's `u64::to_be_bytes`. */
function u64BE(value: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * An end-to-end encrypted private message.
 *
 * Ported from `pubky-messenger` `src/message.rs`. Content and sender are encrypted
 * with the ECDH shared secret; the message is signed over a Blake3 digest of
 * `content || sender_pubkey || timestamp_be`.
 */
export class PrivateMessage {
  constructor(
    public readonly timestamp: number,
    public readonly encryptedSender: Uint8Array,
    public readonly encryptedContent: Uint8Array,
    public readonly signatureBytes: Uint8Array,
  ) {}

  /** Create a new encrypted, signed message from `sender` to `recipient`. */
  static create(senderKeypair: Keypair, recipientPk: PublicKey, content: string): PrivateMessage {
    const contentBytes = utf8ToBytes(content);
    const timestamp = Math.floor(Date.now() / 1000);
    const senderPubBytes = senderKeypair.publicKey.toUint8Array();

    // Digest = blake3(content || sender_pubkey(32) || timestamp_be(8)), then Ed25519-signed.
    const digest = blake3(concatBytes(contentBytes, senderPubBytes, u64BE(timestamp)));
    const signatureBytes = ed25519.sign(digest, senderKeypair.secret());

    // Encryption key = raw 32-byte DH output (hex-decode of the shared-secret hex).
    const key = hexToBytes(generateSharedSecret(senderKeypair, recipientPk));

    const encryptedContent = encrypt(contentBytes, key);
    const encryptedSender = encrypt(utf8ToBytes(senderKeypair.publicKey.z32()), key);

    return new PrivateMessage(timestamp, encryptedSender, encryptedContent, signatureBytes);
  }

  /** Decrypt the message content. */
  decryptContent(receiverKeypair: Keypair, otherParticipant: PublicKey): string {
    const key = hexToBytes(generateSharedSecret(receiverKeypair, otherParticipant));
    return textDecoder.decode(decrypt(this.encryptedContent, key));
  }

  /** Decrypt the sender's public key (z-base32 string). */
  decryptSender(receiverKeypair: Keypair, otherParticipant: PublicKey): string {
    const key = hexToBytes(generateSharedSecret(receiverKeypair, otherParticipant));
    return textDecoder.decode(decrypt(this.encryptedSender, key));
  }

  /**
   * Verify the signature against the decrypted content + sender.
   *
   * Throws if the sender is unparseable or the signature length is wrong; returns
   * `false` for a well-formed but invalid signature (mirrors the Rust semantics).
   */
  verifySignature(decryptedContent: string, decryptedSender: string): boolean {
    const senderPk = PublicKey.from(decryptedSender);
    const senderPkBytes = senderPk.toUint8Array();

    const digest = blake3(
      concatBytes(utf8ToBytes(decryptedContent), senderPkBytes, u64BE(this.timestamp)),
    );

    if (this.signatureBytes.length !== 64) {
      throw new Error('Invalid signature length');
    }

    try {
      return ed25519.verify(this.signatureBytes, digest, senderPkBytes);
    } catch {
      return false;
    }
  }

  /** Generate a unique message ID (UUID v4). */
  static generateId(): string {
    return randomUUID();
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

  /** Parse from the on-the-wire JSON object. */
  static fromJSON(obj: PrivateMessageJson): PrivateMessage {
    return new PrivateMessage(
      obj.timestamp,
      Uint8Array.from(obj.encrypted_sender),
      Uint8Array.from(obj.encrypted_content),
      Uint8Array.from(obj.signature_bytes),
    );
  }

  /** Serialize to a JSON string for storage. */
  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /** Deserialize from a stored JSON string. */
  static deserialize(json: string): PrivateMessage {
    return PrivateMessage.fromJSON(JSON.parse(json) as PrivateMessageJson);
  }
}
