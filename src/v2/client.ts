import { deleteMessages, clearMessages, type MessageDeletion } from '../clear.js';
import { receiveMessages, type MessageFetch } from '../conversation.js';
import {
  FetchFailureError,
  Requests,
  createEngine,
  describeFetchFailure,
  messageUrls,
  type EngineContext,
  type FetchConfig,
} from '../engine.js';
import {
  discover,
  receiveNew,
  retrieve,
  type Discovery,
  type PendingMessage,
  type ReceiveState,
  type ReceivedMessages,
} from '../incremental.js';
import { PrivateMessage } from '../message.js';
import type { RequestStats } from '../metrics.js';
import { PREPARED_V2, PreparedMessage, publishPrepared } from '../prepared.js';
import type { MessengerStorage } from '../storage.js';
import { parseZ32PublicKey } from '../z32.js';
import { KEY_RECORD_PATH, messagingSeed, type MessagingIdentity } from './keys.js';
import { v2Conversation, type V2Conversation } from './message.js';
import { buildKeyRecord, parseKeyRecord, type KeyRecord } from './record.js';

/** Options for `MessengerV2Client`. */
export interface MessengerV2Options {
  /** Own identity key `I`, bare z-base-32. */
  owner: string;
  /** Messaging keypair derived from the messaging seed. The client does not dispose it. */
  identity: MessagingIdentity;
  /** Storage whose writes land in `owner`'s storage (a session authorized for `/pub/private_messages/`). */
  storage: MessengerStorage;
  fetchConfig?: Partial<FetchConfig>;
  /** Clock in Unix milliseconds, for message timestamps and key records. Defaults to `Date.now`. */
  now?: () => number;
}

/** Cancellation for a network operation. */
export interface V2OperationOptions {
  signal?: AbortSignal;
}

/** Result of `discoverConversations`. */
export interface ConversationDiscovery {
  /** Peers with a key record whose copy of the conversation holds at least one message. */
  active: string[];
  /** Peers without a key record (404): they have not enabled v2 messaging. */
  withoutKey: string[];
  /** Peers that could not be checked: invalid keys, invalid records, failed requests. */
  failures: Array<{ peer: string; error: string }>;
}

/** The peer has no key record, so there is no v2 conversation with it. */
export class MessagingNotEnabledError extends Error {
  constructor(readonly peer: string) {
    super(`${peer} has not enabled v2 messaging (no key record)`);
    this.name = 'MessagingNotEnabledError';
  }
}

/**
 * Client for protocol v2 (PROTOCOL-v2.md): messaging keys published in key records, so an app
 * holding only a grant session and its messaging seed can message without the identity secret.
 *
 * Shares the request engine, incremental receive, prepared publication and cleanup with the v1
 * client; only the directory, encoding and verification differ.
 */
export class MessengerV2Client {
  private readonly ownerKey: string;
  private readonly identity: MessagingIdentity;
  private readonly engine: EngineContext;
  private readonly now: () => number;
  private readonly records = new Map<string, KeyRecord>();

  constructor(options: MessengerV2Options) {
    parseZ32PublicKey(options.owner, 'owner');
    this.ownerKey = options.owner;
    this.identity = options.identity;
    this.engine = createEngine(options.storage, options.fetchConfig);
    this.now = options.now ?? Date.now;
  }

  /** Own identity key, bare z-base-32. */
  owner(): string {
    return this.ownerKey;
  }

  /** Own messaging key `M`, bare z-base-32. */
  messagingKey(): string {
    return this.identity.publicKeyZ32();
  }

  /** Write this identity's key record. Republishing is idempotent apart from `createdAt`. */
  async publishKeyRecord(options: V2OperationOptions = {}): Promise<KeyRecord> {
    const { record, body } = buildKeyRecord(
      this.identity,
      this.ownerKey,
      Math.floor(this.now()) * 1000,
    );
    const url = `pubky://${this.ownerKey}${KEY_RECORD_PATH}`;
    const result = await new Requests(this.engine, { signal: options.signal }).publish(url, body);
    if (!result.ok) throw new FetchFailureError(result.failure);
    this.records.set(this.ownerKey, record);
    return record;
  }

  /**
   * The verified key record of `peer`, or null if it has none (404: v2 not enabled). Throws
   * `InvalidKeyRecordError` for a record that does not verify, and `FetchFailureError` if it
   * could not be retrieved. Valid records are cached in memory; `refresh` bypasses the cache.
   * Absent records are not cached.
   */
  async fetchKeyRecord(
    peer: string,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<KeyRecord | null> {
    parseZ32PublicKey(peer, 'peer');
    const cached = this.records.get(peer);
    if (cached && !options.refresh) return cached;
    const url = `pubky://${peer}${KEY_RECORD_PATH}`;
    const result = await new Requests(this.engine, { signal: options.signal }).retrieve(url);
    if (!result.ok) throw new FetchFailureError(result.failure);
    if (result.value.kind !== 'found') {
      this.records.delete(peer);
      return null;
    }
    const record = parseKeyRecord(result.value.body, peer);
    this.records.set(peer, record);
    return record;
  }

  private async conversation(peer: string, signal?: AbortSignal): Promise<V2Conversation> {
    parseZ32PublicKey(peer, 'peer');
    const record = await this.fetchKeyRecord(peer, { signal });
    if (!record) throw new MessagingNotEnabledError(peer);
    return v2Conversation({
      identity: this.identity,
      owner: this.ownerKey,
      peer,
      peerMessagingKey: record.messagingKey,
    });
  }

  /**
   * Prepare an encrypted v2 message. Fetches the peer's key record (once, then cached); the
   * message itself is encrypted and signed without further I/O. Persist `prepared.toJSON()`
   * before `publishMessage`.
   */
  async prepareMessage(
    peer: string,
    content: string,
    options: V2OperationOptions = {},
  ): Promise<PreparedMessage> {
    const conversation = await this.conversation(peer, options.signal);
    const timestamp = Math.floor(this.now() / 1000);
    return PreparedMessage.seal(
      {
        version: PREPARED_V2,
        id: PrivateMessage.generateId(),
        owner: this.ownerKey,
        recipient: peer,
        payload: conversation.encode(content, timestamp),
      },
      messagingSeed(this.identity),
    );
  }

  /**
   * Publish the prepared bytes at their stable ID, returning the message UUID once stored.
   * The envelope is authenticated under this client's messaging key before any request, and
   * the destination is derived from the local identity and the recipient's key record.
   */
  async publishMessage(
    prepared: PreparedMessage,
    options: V2OperationOptions = {},
  ): Promise<string> {
    if (prepared.version() !== PREPARED_V2) {
      throw new Error('Unsupported prepared message version');
    }
    if (prepared.owner() !== this.ownerKey) {
      throw new Error('Prepared message belongs to another identity');
    }
    prepared.validate({ messagingKey: this.identity.publicKeyZ32() });
    const conversation = await this.conversation(prepared.recipient(), options.signal);
    if (!conversation.verifyOwn(prepared.payload())) {
      throw new Error('Invalid prepared message signature');
    }
    const url = `${conversation.sides[0].directory}${prepared.id()}.json`;
    return publishPrepared(this.engine, url, prepared, options.signal);
  }

  /** Prepare and publish one message. Durable callers should use the two steps separately. */
  async sendMessage(
    peer: string,
    content: string,
    options: V2OperationOptions = {},
  ): Promise<string> {
    return this.publishMessage(await this.prepareMessage(peer, content, options), options);
  }

  /** Every message in the conversation that could be retrieved, oldest first, and what could not. */
  async fetchMessages(peer: string, options: V2OperationOptions = {}): Promise<MessageFetch> {
    return receiveMessages(
      this.engine,
      await this.conversation(peer, options.signal),
      options.signal,
    );
  }

  /** The messages `state` has not acknowledged. Acknowledge each with `state.acknowledge`. */
  async receiveNewMessages(
    peer: string,
    state: ReceiveState,
    options: V2OperationOptions = {},
  ): Promise<ReceivedMessages> {
    const conversation = await this.conversation(peer, options.signal);
    return receiveNew(this.engine, conversation, state, options.signal);
  }

  /** List the messages `state` has not acknowledged, without downloading them. */
  async discoverMessages(
    peer: string,
    state: ReceiveState,
    options: V2OperationOptions = {},
  ): Promise<Discovery> {
    return discover(
      this.engine,
      await this.conversation(peer, options.signal),
      state,
      options.signal,
    );
  }

  /** Download and decrypt messages returned by `discoverMessages`. */
  async retrieveMessages(
    peer: string,
    pending: readonly PendingMessage[],
    options: V2OperationOptions = {},
  ): Promise<ReceivedMessages> {
    return retrieve(
      this.engine,
      await this.conversation(peer, options.signal),
      pending,
      options.signal,
    );
  }

  /** Delete selected sent messages (UUIDs) and report every outcome; 404 counts as deleted. */
  async deleteMessagesWithReport(
    ids: string[],
    peer: string,
    options: V2OperationOptions = {},
  ): Promise<MessageDeletion> {
    const own = (await this.conversation(peer, options.signal)).sides[0];
    return deleteMessages(this.engine, own, ids, options.signal);
  }

  /** Delete every message this identity stored in the conversation, and report each outcome. */
  async clearMessagesWithReport(
    peer: string,
    options: V2OperationOptions = {},
  ): Promise<MessageDeletion> {
    const own = (await this.conversation(peer, options.signal)).sides[0];
    return clearMessages(this.engine, own, options.signal);
  }

  /**
   * Check candidate peers (for example follows and followers) for incoming conversations: fetch
   * each peer's key record, then list the peer's copy of the conversation. A peer is active when
   * that listing holds at least one message file.
   */
  async discoverConversations(
    peers: string[],
    options: V2OperationOptions = {},
  ): Promise<ConversationDiscovery> {
    const { signal } = options;
    const unique = [...new Set(peers)];
    const results = await Promise.all(
      unique.map(async (peer): Promise<{ active?: true; withoutKey?: true; error?: string }> => {
        try {
          parseZ32PublicKey(peer, 'peer');
          const record = await this.fetchKeyRecord(peer, { signal });
          if (!record) return { withoutKey: true };
          const conversation = v2Conversation({
            identity: this.identity,
            owner: this.ownerKey,
            peer,
            peerMessagingKey: record.messagingKey,
          });
          const directory = conversation.sides[1].directory;
          const listing = await new Requests(this.engine, { signal }).list(directory);
          if (!listing.ok) return { error: describeFetchFailure(listing.failure) };
          return messageUrls(directory, listing.value ?? []).urls.length > 0
            ? { active: true }
            : {};
        } catch (e) {
          if (signal?.aborted) throw e;
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    const discovery: ConversationDiscovery = { active: [], withoutKey: [], failures: [] };
    unique.forEach((peer, i) => {
      const result = results[i]!;
      if (result.active) discovery.active.push(peer);
      else if (result.withoutKey) discovery.withoutKey.push(peer);
      else if (result.error !== undefined) discovery.failures.push({ peer, error: result.error });
    });
    return discovery;
  }

  /** Cumulative storage request counters for this client. */
  requestStats(): RequestStats {
    return this.engine.metrics.snapshot();
  }
}
