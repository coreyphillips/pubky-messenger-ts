import { ConversationKey } from './crypto.js';
import {
  Requests,
  messageUrls,
  type EngineContext,
  type FailureReason,
  type FetchFailure,
} from './engine.js';
import { decodeV1Message, type DecryptedMessage } from './message.js';

/**
 * Internal protocol abstraction. A conversation knows the two directories it lives in and how
 * to turn a stored body into a message; the engine, incremental receive, prepared publication
 * and cleanup work on it without knowing the protocol version.
 */

/** One participant's copy of the conversation. */
export interface ConversationSide {
  /** Bare z-base-32 identity key of the participant who writes to `directory`. */
  publisher: string;
  /** `pubky://<publisher>/pub/.../` directory URL, ending in `/`. */
  directory: string;
}

export type Decoded =
  | { kind: 'message'; message: DecryptedMessage }
  /** Not a message this conversation can decrypt. */
  | { kind: 'undecryptable' }
  /** A body that must be reported as a retrieval failure rather than a message. */
  | { kind: 'failure'; reason: FailureReason };

export interface Conversation {
  /** The reader's own copy first, then the other participant's. */
  readonly sides: readonly [ConversationSide, ConversationSide];
  /** Decode a body listed in `publisher`'s directory. */
  decode(body: Uint8Array, publisher: string): Decoded;
}

/** The v1 conversation between an identity secret key and a peer identity key. */
export function v1Conversation(
  secretKey: Uint8Array,
  owner: string,
  peer: string,
  peerPublic: Uint8Array,
): Conversation {
  const key = ConversationKey.derive(secretKey, peerPublic);
  const path = key.path();
  return {
    sides: [
      { publisher: owner, directory: `pubky://${owner}${path}` },
      { publisher: peer, directory: `pubky://${peer}${path}` },
    ],
    decode(body) {
      const message = decodeV1Message(body, key);
      return message ? { kind: 'message', message } : { kind: 'undecryptable' };
    },
  };
}

/** Messages read from a conversation, and whatever could not be retrieved. */
export interface MessageFetch {
  /**
   * Decrypted messages, oldest first. Messages with equal timestamps keep listing order: the
   * reader's own directory first, then the other participant's.
   */
  messages: DecryptedMessage[];
  /** Listings and messages that could not be retrieved. If any are present, `messages` is incomplete. */
  failures: FetchFailure[];
}

/** Read every message in `conversation`. */
export async function receiveMessages(
  ctx: EngineContext,
  conversation: Conversation,
  signal?: AbortSignal,
): Promise<MessageFetch> {
  const requests = new Requests(ctx, { signal });
  const listings = await Promise.all(
    conversation.sides.map((side) => requests.list(side.directory)),
  );

  const failures: FetchFailure[] = [];
  const listed: Array<{ url: string; publisher: string }> = [];
  conversation.sides.forEach((side, i) => {
    const listing = listings[i]!;
    if (!listing.ok) {
      failures.push(listing.failure);
      return;
    }
    const { urls, outside } = messageUrls(side.directory, listing.value ?? []);
    for (const url of urls) listed.push({ url, publisher: side.publisher });
    failures.push(...outside);
  });

  // Decode each body as it arrives rather than holding every body until the last request ends
  const results = await Promise.all(
    listed.map(async ({ url, publisher }) => {
      const result = await requests.retrieve(url);
      if (!result.ok) return { failure: result.failure };
      if (result.value.kind !== 'found') return {};
      const decoded = conversation.decode(result.value.body, publisher);
      if (decoded.kind === 'message') return { message: decoded.message };
      if (decoded.kind === 'failure')
        return { failure: { url, attempts: 1, reason: decoded.reason } };
      // Deleted after it was listed, or not a message this conversation can decrypt
      return {};
    }),
  );

  const messages: Array<{ position: number; message: DecryptedMessage }> = [];
  results.forEach((result, position) => {
    if ('message' in result && result.message) messages.push({ position, message: result.message });
    else if ('failure' in result && result.failure) failures.push(result.failure);
  });
  messages.sort((a, b) => a.message.timestamp - b.message.timestamp || a.position - b.position);

  return { messages: messages.map((m) => m.message), failures };
}
