import { compareCodePoints } from './bytes.js';
import type { Conversation } from './conversation.js';
import {
  Requests,
  isMessageUrl,
  messageUrls,
  outsideConversation,
  type EngineContext,
  type FetchFailure,
} from './engine.js';
import type { DecryptedMessage } from './message.js';

/**
 * Incremental receive. Ported from `pubky-messenger` `src/incremental.rs`.
 */

/** Where a message is published, known from a directory listing before its body is downloaded. */
export interface MessageId {
  /** Bare z-base-32 key of the participant whose directory holds the message. */
  publisher: string;
  /** `pubky://` URL of the message, as listed by the publisher's homeserver. */
  url: string;
}

/** Whether a message can change after it has been acknowledged. */
export const ChangePolicy = {
  /**
   * Each message is written once, at a new random name, and never rewritten. This library only
   * publishes messages that way. An acknowledged message is not requested again while it is
   * listed, so a body rewritten in place is not seen.
   */
  WriteOnce: 'WriteOnce',
  /**
   * Acknowledged messages may be rewritten in place. Every acknowledged message still listed is
   * requested again on each discovery, conditional on the entity tag it was acknowledged at. An
   * unchanged message costs a request but no body; a changed one is delivered again with
   * `updated` set. A message acknowledged without an entity tag is not rechecked. Needs a
   * storage adapter with `getConditional`.
   */
  Revalidate: 'Revalidate',
} as const;
export type ChangePolicy = (typeof ChangePolicy)[keyof typeof ChangePolicy];

/** JSON shape of a `ReceiveState`, the same as the Rust crate's serde output. */
export interface ReceiveStateJson {
  change_policy: ChangePolicy;
  /** Entity tag each message was acknowledged at, by publisher and message URL. */
  acknowledged: Record<string, Record<string, string | null>>;
}

/** A listed message whose body has not been retrieved. */
export interface PendingMessage {
  id: MessageId;
  /** Entity tag the message was acknowledged at, if it is being revalidated. */
  acknowledgedEtag: string | null;
}

/** A retrieved message with its identity. */
export interface ReceivedMessage {
  id: MessageId;
  /**
   * Null if the body is not a message this conversation can decrypt. Acknowledge it too, or it
   * is downloaded again on every receive.
   */
  message: DecryptedMessage | null;
  /** Entity tag the homeserver sent with the body, when the adapter reports one. */
  etag: string | null;
  /** The message was acknowledged before and its body has changed since. */
  updated: boolean;
}

/** Messages found by listing a conversation. */
export interface Discovery {
  /**
   * Unacknowledged messages in listing order, the reader's own directory first. Under
   * `ChangePolicy.Revalidate`, acknowledged messages to recheck follow them.
   */
  pending: PendingMessage[];
  /** Listings that could not be read, and listed entries that are not files in the conversation. */
  failures: FetchFailure[];
  /** Publishers whose directory listing completed. */
  listedPublishers: string[];
  /** Whether both directory listings completed. */
  complete: boolean;
}

/** Messages retrieved from a conversation, and whatever could not be retrieved. */
export interface ReceivedMessages {
  /**
   * Oldest first, with equal timestamps in the order given, then bodies that could not be
   * decrypted. Messages deleted since they were listed, and unchanged ones being revalidated,
   * are left out.
   */
  messages: ReceivedMessage[];
  /**
   * Listings and messages that could not be retrieved. Unretrieved messages stay
   * unacknowledged, so the next discovery returns them again.
   */
  failures: FetchFailure[];
  /** Publishers whose directory listing completed (receive only; empty for a bare retrieval). */
  listedPublishers: string[];
  /** Whether both directory listings completed (receive only; false for a bare retrieval). */
  complete: boolean;
}

/**
 * Messages a caller has acknowledged in one conversation.
 *
 * Discovery lists both participants' directories in full on every call and returns the entries
 * this state has not acknowledged. Message names are random, so their order says nothing about
 * when a message was published, and there is no cursor to resume from.
 *
 * The state holds one entry per acknowledged message that was still listed at the last
 * discovery. When a listing completes, acknowledgements for messages no longer in it are
 * dropped, so the state never outgrows the conversation as stored. A listing that fails leaves
 * that directory's acknowledgements as they were.
 *
 * Delivery is at least once: a message is returned by every discovery until it is
 * acknowledged. Acknowledge after processing, then persist `state.toJSON()` (or
 * `JSON.stringify(state)`); restore with `ReceiveState.fromJSON`. A state that was not persisted
 * after an acknowledgement redelivers that message.
 */
export class ReceiveState {
  private readonly policy: ChangePolicy;
  /** @internal */
  acknowledged = new Map<string, Map<string, string | null>>();
  private listing: { complete: boolean; publishers: string[] } | null = null;

  constructor(changePolicy: ChangePolicy = ChangePolicy.WriteOnce) {
    if (changePolicy !== ChangePolicy.WriteOnce && changePolicy !== ChangePolicy.Revalidate) {
      throw new Error(`Unknown change policy: ${String(changePolicy)}`);
    }
    this.policy = changePolicy;
  }

  get changePolicy(): ChangePolicy {
    return this.policy;
  }

  /** Stop returning `message` from discovery, unless it changes under `ChangePolicy.Revalidate`. */
  acknowledge(message: ReceivedMessage): void {
    const etag = this.policy === ChangePolicy.Revalidate ? message.etag : null;
    let messages = this.acknowledged.get(message.id.publisher);
    if (!messages) {
      messages = new Map();
      this.acknowledged.set(message.id.publisher, messages);
    }
    messages.set(message.id.url, etag);
  }

  isAcknowledged(id: MessageId): boolean {
    return this.acknowledged.get(id.publisher)?.has(id.url) ?? false;
  }

  /**
   * Every acknowledged message this state tracks, by publisher then URL. After a complete
   * listing (`lastListingComplete`), these are exactly the acknowledged messages still listed,
   * so an id that disappeared was deleted by its publisher. After a failed listing, that
   * publisher's ids are kept as they were and may include deleted messages.
   */
  acknowledgedIds(): MessageId[] {
    const ids: MessageId[] = [];
    for (const publisher of [...this.acknowledged.keys()].sort(compareCodePoints)) {
      const urls = [...this.acknowledged.get(publisher)!.keys()].sort(compareCodePoints);
      for (const url of urls) ids.push({ publisher, url });
    }
    return ids;
  }

  /**
   * Whether the most recent discovery through this object listed both directories completely,
   * or null if none ran since it was created or restored. Not persisted.
   */
  get lastListingComplete(): boolean | null {
    return this.listing ? this.listing.complete : null;
  }

  /** Publishers whose directory the most recent discovery listed completely, or null. Not persisted. */
  get lastListedPublishers(): string[] | null {
    return this.listing ? [...this.listing.publishers] : null;
  }

  /** @internal */
  recordListing(publishers: string[], complete: boolean): void {
    this.listing = { complete, publishers };
  }

  /** Number of acknowledged messages being tracked. */
  get size(): number {
    let n = 0;
    for (const messages of this.acknowledged.values()) n += messages.size;
    return n;
  }

  isEmpty(): boolean {
    return this.size === 0;
  }

  /** Whether both states hold the same policy and acknowledgements. */
  equals(other: ReceiveState): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  /** Plain JSON object, keys sorted like Rust's `BTreeMap`. */
  toJSON(): ReceiveStateJson {
    const acknowledged: Record<string, Record<string, string | null>> = {};
    for (const publisher of [...this.acknowledged.keys()].sort(compareCodePoints)) {
      const messages = this.acknowledged.get(publisher)!;
      const entry: Record<string, string | null> = {};
      for (const url of [...messages.keys()].sort(compareCodePoints))
        entry[url] = messages.get(url)!;
      acknowledged[publisher] = entry;
    }
    return { change_policy: this.policy, acknowledged };
  }

  /** Restore from `toJSON()` output (or its string form). Throws on a malformed value. */
  static fromJSON(json: ReceiveStateJson | string | unknown): ReceiveState {
    const value: unknown = typeof json === 'string' ? JSON.parse(json) : json;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Invalid receive state: expected an object');
    }
    const v = value as Record<string, unknown>;
    if (v.change_policy !== ChangePolicy.WriteOnce && v.change_policy !== ChangePolicy.Revalidate) {
      throw new Error('Invalid receive state: change_policy');
    }
    const state = new ReceiveState(v.change_policy);
    const acknowledged = v.acknowledged;
    if (typeof acknowledged !== 'object' || acknowledged === null || Array.isArray(acknowledged)) {
      throw new Error('Invalid receive state: acknowledged');
    }
    for (const [publisher, messages] of Object.entries(acknowledged)) {
      if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
        throw new Error('Invalid receive state: acknowledged messages');
      }
      const map = new Map<string, string | null>();
      for (const [url, etag] of Object.entries(messages as Record<string, unknown>)) {
        if (etag !== null && typeof etag !== 'string') {
          throw new Error('Invalid receive state: entity tag');
        }
        map.set(url, etag);
      }
      state.acknowledged.set(publisher, map);
    }
    return state;
  }
}

/** List both directories of the conversation and return what `state` has not acknowledged. */
export async function discover(
  ctx: EngineContext,
  conversation: Conversation,
  state: ReceiveState,
  signal?: AbortSignal,
): Promise<Discovery> {
  const publishers = conversation.sides.map((side) => side.publisher);
  for (const stranger of state.acknowledged.keys()) {
    if (!publishers.includes(stranger)) {
      throw new Error(
        `Receive state belongs to another conversation: it holds messages published by ${stranger}`,
      );
    }
  }

  const requests = new Requests(ctx, { signal });
  const listings = await Promise.all(
    conversation.sides.map((side) => requests.list(side.directory)),
  );

  const revalidate = state.changePolicy === ChangePolicy.Revalidate;
  const unacknowledged: PendingMessage[] = [];
  const revalidations: PendingMessage[] = [];
  const failures: FetchFailure[] = [];
  const listedPublishers: string[] = [];

  conversation.sides.forEach((side, i) => {
    const listing = listings[i]!;
    if (!listing.ok) {
      failures.push(listing.failure);
      return;
    }
    listedPublishers.push(side.publisher);
    const { urls, outside } = messageUrls(side.directory, listing.value ?? []);
    failures.push(...outside);

    const previous = state.acknowledged.get(side.publisher) ?? new Map<string, string | null>();
    state.acknowledged.delete(side.publisher);
    const listed = new Set(urls);
    const acknowledged = new Map([...previous].filter(([url]) => listed.has(url)));

    for (const url of urls) {
      const id = { publisher: side.publisher, url };
      if (!acknowledged.has(url)) {
        unacknowledged.push({ id, acknowledgedEtag: null });
      } else {
        const etag = acknowledged.get(url);
        if (revalidate && typeof etag === 'string')
          revalidations.push({ id, acknowledgedEtag: etag });
      }
    }
    if (acknowledged.size > 0) state.acknowledged.set(side.publisher, acknowledged);
  });

  const complete = listedPublishers.length === conversation.sides.length;
  state.recordListing(listedPublishers, complete);
  return { pending: [...unacknowledged, ...revalidations], failures, listedPublishers, complete };
}

/** Download and decrypt the bodies of `pending` messages. */
export async function retrieve(
  ctx: EngineContext,
  conversation: Conversation,
  pending: readonly PendingMessage[],
  signal?: AbortSignal,
): Promise<ReceivedMessages> {
  const requests = new Requests(ctx, { signal });

  const results = await Promise.all(
    pending.map(async (p): Promise<{ received?: ReceivedMessage; failure?: FetchFailure }> => {
      // Pending messages may have been stored and restored by the caller
      const { publisher, url } = p.id;
      if (
        !conversation.sides.some((s) => s.publisher === publisher && isMessageUrl(s.directory, url))
      ) {
        return { failure: outsideConversation(url) };
      }
      const known = p.acknowledgedEtag ?? undefined;
      const result = await requests.retrieve(url, { conditional: true, ifNoneMatch: known });
      if (!result.ok) return { failure: result.failure };
      if (result.value.kind !== 'found') return {};
      const { body, etag } = result.value;
      // A homeserver may ignore If-None-Match and send the same body again
      if (known !== undefined && etag === known) return {};

      const decoded = conversation.decode(body, publisher);
      if (decoded.kind === 'failure')
        return { failure: { url, attempts: 1, reason: decoded.reason } };
      return {
        received: {
          id: { publisher, url },
          message: decoded.kind === 'message' ? decoded.message : null,
          etag,
          updated: known !== undefined,
        },
      };
    }),
  );

  const messages: Array<{ position: number; received: ReceivedMessage }> = [];
  const failures: FetchFailure[] = [];
  results.forEach((result, position) => {
    if (result.received) messages.push({ position, received: result.received });
    else if (result.failure) failures.push(result.failure);
  });
  messages.sort((a, b) => {
    const ta = a.received.message?.timestamp;
    const tb = b.received.message?.timestamp;
    if ((ta === undefined) !== (tb === undefined)) return ta === undefined ? 1 : -1;
    return (ta ?? 0) - (tb ?? 0) || a.position - b.position;
  });

  return {
    messages: messages.map((m) => m.received),
    failures,
    listedPublishers: [],
    complete: false,
  };
}

/** Discover and retrieve in one call. */
export async function receiveNew(
  ctx: EngineContext,
  conversation: Conversation,
  state: ReceiveState,
  signal?: AbortSignal,
): Promise<ReceivedMessages> {
  const discovery = await discover(ctx, conversation, state, signal);
  const received = await retrieve(ctx, conversation, discovery.pending, signal);
  return {
    messages: received.messages,
    failures: [...discovery.failures, ...received.failures],
    listedPublishers: discovery.listedPublishers,
    complete: discovery.complete,
  };
}
