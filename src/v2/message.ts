import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import {
  concatBytes,
  decodeUtf8Lossy,
  decodeUtf8Strict,
  isByteArray,
  isU64,
  u64BE,
  utf8,
} from '../bytes.js';
import { conversationId, x25519SharedSecret } from '../crypto.js';
import type { Conversation, Decoded } from '../conversation.js';
import { decrypt, encrypt } from '../secretbox.js';
import { parseZ32PublicKey } from '../z32.js';
import { messagingSeed, type MessagingIdentity } from './keys.js';

/**
 * Protocol v2 conversations and messages (PROTOCOL-v2.md sections 4 and 5).
 */

/** Parent of every v2 conversation directory. */
export const V2_CONVERSATIONS_PATH = '/pub/private_messages/v2/';

const MESSAGE_DOMAIN = utf8('pubky-messenger/v2/message');

/** Stored JSON of a v2 message, keys in this order. */
export interface V2MessageJson {
  version: 2;
  timestamp: number;
  encrypted_sender: number[];
  encrypted_content: number[];
  signature_bytes: number[];
}

/** Validate a parsed value as a v2 message. Throws unless it has version 2 and every field. */
export function parseV2MessageJson(value: unknown): V2MessageJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid v2 message: expected a JSON object');
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 2) throw new Error('Invalid v2 message: version');
  if (!isU64(v.timestamp)) throw new Error('Invalid v2 message: timestamp');
  for (const field of ['encrypted_sender', 'encrypted_content', 'signature_bytes'] as const) {
    if (!isByteArray(v[field])) throw new Error(`Invalid v2 message: ${field}`);
  }
  return {
    version: 2,
    timestamp: v.timestamp,
    encrypted_sender: v.encrypted_sender as number[],
    encrypted_content: v.encrypted_content as number[],
    signature_bytes: v.signature_bytes as number[],
  };
}

/** `blake3("pubky-messenger/v2/message" || content || sender_I || recipient_I || u64_be(timestamp))` */
export function v2MessageDigest(
  content: string,
  sender: Uint8Array,
  recipient: Uint8Array,
  timestamp: number,
): Uint8Array {
  return blake3(concatBytes(MESSAGE_DOMAIN, utf8(content), sender, recipient, u64BE(timestamp)));
}

/** Everything one participant needs for a v2 conversation with one peer. */
export interface V2Participants {
  identity: MessagingIdentity;
  /** Own identity key `I`, bare z-base-32. */
  owner: string;
  /** Peer identity key, bare z-base-32. */
  peer: string;
  /** Peer messaging key `M`, bare z-base-32, from its verified key record. */
  peerMessagingKey: string;
}

export interface V2Conversation extends Conversation {
  /** `/pub/private_messages/v2/<cid>/` */
  readonly path: string;
  /** Encode a message from the owner to the peer. */
  encode(content: string, timestamp: number): Uint8Array;
  /** Decode the owner's own message and check it names the owner and verifies. */
  verifyOwn(body: Uint8Array): { content: string; timestamp: number } | null;
}

/** The v2 conversation between `owner` and `peer`. Throws for a small-order peer messaging key. */
export function v2Conversation(p: V2Participants): V2Conversation {
  const ownerRaw = parseZ32PublicKey(p.owner, 'owner');
  const peerRaw = parseZ32PublicKey(p.peer, 'peer');
  const peerM = parseZ32PublicKey(p.peerMessagingKey, 'peer messaging key');
  const ownM = p.identity.publicKeyBytes();
  const shared = x25519SharedSecret(messagingSeed(p.identity), peerM);
  const path = `${V2_CONVERSATIONS_PATH}${conversationId(shared)}/`;

  // The signer's messaging key and the recipient's identity, by directory owner
  const roles = new Map<string, { sender: Uint8Array; recipient: Uint8Array; signer: Uint8Array }>([
    [p.owner, { sender: ownerRaw, recipient: peerRaw, signer: ownM }],
    [p.peer, { sender: peerRaw, recipient: ownerRaw, signer: peerM }],
  ]);

  const decode = (body: Uint8Array, publisher: string): Decoded => {
    const role = roles.get(publisher);
    if (!role) return { kind: 'failure', reason: { kind: 'senderMismatch' } };
    let json: V2MessageJson;
    let sender: string;
    try {
      json = parseV2MessageJson(JSON.parse(decodeUtf8Lossy(body)));
      sender = decodeUtf8Strict(decrypt(Uint8Array.from(json.encrypted_sender), shared));
    } catch {
      return { kind: 'undecryptable' };
    }
    // Only the directory owner may be the sender of what its directory holds
    if (sender !== publisher) return { kind: 'failure', reason: { kind: 'senderMismatch' } };
    let content: string;
    try {
      content = decodeUtf8Strict(decrypt(Uint8Array.from(json.encrypted_content), shared));
    } catch {
      return { kind: 'undecryptable' };
    }
    let verified = false;
    if (json.signature_bytes.length === 64) {
      try {
        verified = ed25519.verify(
          Uint8Array.from(json.signature_bytes),
          v2MessageDigest(content, role.sender, role.recipient, json.timestamp),
          role.signer,
        );
      } catch {
        verified = false;
      }
    }
    return { kind: 'message', message: { sender, content, timestamp: json.timestamp, verified } };
  };

  return {
    sides: [
      { publisher: p.owner, directory: `pubky://${p.owner}${path}` },
      { publisher: p.peer, directory: `pubky://${p.peer}${path}` },
    ],
    path,
    decode,
    encode(content, timestamp) {
      const signature = ed25519.sign(
        v2MessageDigest(content, ownerRaw, peerRaw, timestamp),
        messagingSeed(p.identity),
      );
      const json: V2MessageJson = {
        version: 2,
        timestamp,
        encrypted_sender: Array.from(encrypt(utf8(p.owner), shared)),
        encrypted_content: Array.from(encrypt(utf8(content), shared)),
        signature_bytes: Array.from(signature),
      };
      return utf8(JSON.stringify(json));
    },
    verifyOwn(body) {
      const decoded = decode(body, p.owner);
      if (decoded.kind !== 'message' || !decoded.message.verified) return null;
      return { content: decoded.message.content, timestamp: decoded.message.timestamp };
    },
  };
}
