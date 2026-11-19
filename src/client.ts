import { Keypair, PublicKey, Pubky } from '@synonymdev/pubky';
import type { Address, Path, Session } from '@synonymdev/pubky';
import { validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { clearMessages, deleteMessages, deletionResult, type MessageDeletion } from './clear.js';
import {
  receiveMessages,
  v1Conversation,
  type Conversation,
  type MessageFetch,
} from './conversation.js';
import {
  createEngine,
  describeFetchFailure,
  resolveFetchConfig,
  RequestBudget,
  type EngineContext,
  type FetchConfig,
} from './engine.js';
import {
  discover,
  receiveNew,
  retrieve,
  type Discovery,
  type PendingMessage,
  type ReceiveState,
  type ReceivedMessages,
} from './incremental.js';
import { parsePublicKeyLoose, type DecryptedMessage } from './message.js';
import type { RequestStats } from './metrics.js';
import { prepareV1, publishPrepared, v1Destination, type PreparedMessage } from './prepared.js';
import {
  createPubkyStorageFrom,
  storageErrorInfo,
  type MessengerStorage,
  type SessionSource,
} from './storage.js';
import { z32Encode } from './z32.js';

/** Profile information stored under the `pubky.app` app namespace. */
export interface PubkyProfile {
  name: string;
  bio?: string | null;
  image?: string | null;
  status?: string | null;
}

/** A user that is being followed. */
export interface FollowedUser {
  name?: string;
  pubky: string;
}

/** A BIP39 wordlist (from `@scure/bip39/wordlists/*`). */
export type Wordlist = string[];

/** A peer identity: an SDK `PublicKey`, or its z-base-32 text (bare, `pubky`- or `pk:`-prefixed). */
export type PeerKey = PublicKey | string;

/** Options for `PrivateMessengerClient`. */
export interface PrivateMessengerOptions {
  /** The SDK facade to use. Defaults to `new Pubky()` (mainnet relays). */
  pubky?: Pubky;
  /**
   * Storage for conversation reads, publication and cleanup. Defaults to the
   * `@synonymdev/pubky` adapter, signing in on the first write when no session is kept.
   */
  storage?: MessengerStorage;
  /** Concurrency limits, deadlines and retries. Unset fields use `DEFAULT_FETCH_CONFIG`. */
  fetchConfig?: Partial<FetchConfig>;
  /** Client ID recorded with each session grant. Defaults to `pubky-messenger`. */
  clientId?: string;
}

/** Cancellation for a network operation. */
export interface OperationOptions {
  signal?: AbortSignal;
}

/** Names this library to homeservers, which record the client holding each session grant. */
export const DEFAULT_CLIENT_ID = 'pubky-messenger';

const asPath = (p: string): Path => p as Path;
const asAddress = (a: string): Address => a as Address;

/** Normalize a peer key to its bare z-base-32 text and raw bytes. */
export function peerKey(peer: PeerKey): { z32: string; bytes: Uint8Array } {
  let bytes: Uint8Array | null;
  if (typeof peer === 'string') {
    const text = /^pubky[a-km-uw-z13-9]{52}$/.test(peer) ? peer.slice('pubky'.length) : peer;
    bytes = parsePublicKeyLoose(text);
  } else {
    bytes = peer.toUint8Array();
  }
  if (!bytes || bytes.length !== 32) {
    throw new Error('Invalid public key');
  }
  return { z32: z32Encode(bytes), bytes };
}

/**
 * Client for end-to-end encrypted private messaging over the Pubky network (protocol v1).
 *
 * A TypeScript port of the Rust `PrivateMessengerClient` 0.5.0. Conversation storage goes
 * through a `MessengerStorage` adapter and the shared request engine; profiles and follows use
 * the SDK directly.
 */
export class PrivateMessengerClient {
  private readonly pubkyFacade: Pubky;
  private readonly identity: Keypair;
  private readonly owner: string;
  private readonly clientId: string;
  private engine: EngineContext;
  private kept: Session | null = null;
  private pendingSession: Promise<Session> | null = null;

  /** Create a client from a keypair. */
  constructor(keypair: Keypair, options: PrivateMessengerOptions = {}) {
    this.identity = keypair;
    this.owner = keypair.publicKey.z32();
    this.pubkyFacade = options.pubky ?? new Pubky();
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    const storage =
      options.storage ?? createPubkyStorageFrom(this.pubkyFacade, this.sessionSource());
    this.engine = createEngine(storage, options.fetchConfig);
  }

  /**
   * Create a client from a `.pkarr` recovery file.
   * @param passphrase Defaults to an empty string.
   */
  static fromRecoveryFile(
    recoveryFileBytes: Uint8Array,
    passphrase = '',
    options?: PrivateMessengerOptions,
  ): PrivateMessengerClient {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromRecoveryFile(recoveryFileBytes, passphrase);
    } catch (e) {
      // The underlying WASM surfaces a cryptic `aead::Error` on a bad passphrase.
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to decrypt recovery file: wrong passphrase or corrupt file (${detail})`,
      );
    }
    return new PrivateMessengerClient(keypair, options);
  }

  /**
   * Create a client from a 12-word BIP39 recovery phrase.
   *
   * The Ed25519 secret is the first 32 bytes of the BIP39 seed (no derivation path), matching
   * the Rust implementation.
   */
  static fromRecoveryPhrase(
    mnemonicPhrase: string,
    passphrase = '',
    wordlist: Wordlist = englishWordlist,
    options?: PrivateMessengerOptions,
  ): PrivateMessengerClient {
    const normalized = mnemonicPhrase.trim().replace(/\s+/g, ' ');
    if (!validateMnemonic(normalized, wordlist)) {
      throw new Error('Invalid mnemonic phrase');
    }
    const seed = mnemonicToSeedSync(normalized, passphrase);
    const keypair = Keypair.fromSecret(seed.slice(0, 32));
    seed.fill(0);
    return new PrivateMessengerClient(keypair, options);
  }

  /**
   * Replace the concurrency limits, deadlines and retry policy for conversation storage.
   * Unset fields use `DEFAULT_FETCH_CONFIG`. Returns this client.
   */
  withFetchConfig(fetchConfig: Partial<FetchConfig>): this {
    const config = resolveFetchConfig(fetchConfig);
    this.engine = {
      ...this.engine,
      config,
      budget: new RequestBudget(config.maxConcurrentRequests),
    };
    return this;
  }

  /** The policy in effect. */
  fetchConfig(): FetchConfig {
    return { ...this.engine.config };
  }

  /** The SDK facade this client uses. */
  pubky(): Pubky {
    return this.pubkyFacade;
  }

  // --- sessions ---

  /**
   * Sign in to the homeserver with a session grant (client ID `pubky-messenger` by default), or
   * with the deprecated cookie flow on a homeserver that has no grant endpoint. Keeps the
   * session for writes. Sending signs in on its own when no session is kept.
   */
  async signIn(): Promise<Session> {
    const session = await this.newSession();
    this.kept = session;
    return session;
  }

  /**
   * Create an account on `homeserver` and publish it as this identity's homeserver, then sign
   * in. A signup token in an error message is redacted.
   */
  async signUp(homeserver: PeerKey, signupToken?: string | null): Promise<Session> {
    const homeserverKey = PublicKey.from(peerKey(homeserver).z32);
    try {
      await this.pubkyFacade.signer(this.identity).signup(homeserverKey, signupToken ?? null);
    } catch (e) {
      // Transport errors can include the request URL, which may carry the token
      let message = errorMessage(e);
      if (signupToken) message = message.split(signupToken).join('[redacted]');
      throw new Error(`Failed to sign up: ${message}`);
    }
    try {
      return await this.signIn();
    } catch (e) {
      throw new Error(`Signed up, but ${errorMessage(e)}`);
    }
  }

  /**
   * Sign in, creating an account on `homeserver` if this identity has none yet.
   *
   * Sign-up is only attempted when sign-in fails and no homeserver record can be resolved for
   * this key. If a record exists, or the lookup fails, the sign-in error is thrown instead:
   * signing up would republish the record and point the identity away from its data.
   */
  async ensureSession(homeserver: PeerKey, signupToken?: string | null): Promise<Session> {
    let signInError: unknown;
    try {
      return await this.signIn();
    } catch (e) {
      signInError = e;
    }
    let hasRecord = true;
    try {
      hasRecord = (await this.pubkyFacade.getHomeserverOf(this.identity.publicKey)) !== undefined;
    } catch {
      // A failed lookup is not an absent record, so it must not lead to a sign-up either
      hasRecord = true;
    }
    if (hasRecord) throw signInError;
    return this.signUp(homeserver, signupToken);
  }

  /** The session from the last sign-in, sign-up or write, if any. */
  currentSession(): Session | null {
    return this.kept;
  }

  private async newSession(): Promise<Session> {
    const signer = this.pubkyFacade.signer(this.identity);
    try {
      return await signer.signin(this.clientId);
    } catch (e) {
      const status = storageErrorInfo(e).status;
      // Homeservers before 0.16 have no grant endpoint
      if (status === 404 || status === 405) {
        return signer.signinCookie();
      }
      throw e;
    }
  }

  private sessionSource(): SessionSource {
    const establish = (): Promise<Session> => {
      if (!this.pendingSession) {
        this.engine.metrics.sent('session', 0);
        this.pendingSession = this.newSession().then(
          (session) => {
            this.kept = session;
            this.pendingSession = null;
            return session;
          },
          (error: unknown) => {
            this.pendingSession = null;
            throw error;
          },
        );
      }
      return this.pendingSession;
    };
    return {
      // Concurrent first writes share one sign-in rather than each minting a grant
      current: () => (this.kept ? Promise.resolve(this.kept) : establish()),
      renew: (stale) => {
        if (this.kept && this.kept !== stale) return Promise.resolve(this.kept);
        if (this.kept === stale) this.kept = null;
        return establish();
      },
    };
  }

  // --- identity ---

  /** This client's public key. */
  publicKey(): PublicKey {
    return this.identity.publicKey;
  }

  /** This client's public key as a bare z-base-32 string. */
  publicKeyString(): string {
    return this.owner;
  }

  /** This client's keypair, including its secret key. */
  keypair(): Keypair {
    return this.identity;
  }

  // --- messaging ---

  private conversation(other: PeerKey): Conversation {
    const peer = peerKey(other);
    return v1Conversation(this.identity.secret(), this.owner, peer.z32, peer.bytes);
  }

  /**
   * Prepare an encrypted message without network requests. Durable callers persist
   * `prepared.toJSON()` before calling `publishMessage`.
   */
  prepareMessage(recipient: PeerKey, content: string): PreparedMessage {
    return prepareV1(this.identity.secret(), this.owner, peerKey(recipient).z32, content);
  }

  /**
   * Publish the prepared bytes at their stable ID, returning that ID after storage succeeds.
   *
   * Repeated publication uses identical bytes and does not create another resource. Stored does
   * not mean consumed by the peer. A restored value is validated before any request.
   * Cancellation leaves the storage outcome unknown; retry the same value. Storage failures
   * throw `FetchFailureError`.
   */
  async publishMessage(prepared: PreparedMessage, options: OperationOptions = {}): Promise<string> {
    const url = v1Destination(prepared, this.identity.secret(), this.owner);
    return publishPrepared(this.engine, url, prepared, options.signal);
  }

  /**
   * Prepare and publish one message. Durable callers should use the two steps separately:
   * calling this again creates a new message and ID.
   */
  async sendMessage(
    recipient: PeerKey,
    content: string,
    options: OperationOptions = {},
  ): Promise<string> {
    return this.publishMessage(this.prepareMessage(recipient, content), options);
  }

  /** Cumulative LIST/GET/PUT/DELETE/session attempts, body bytes, retries and admission wait. */
  requestStats(): RequestStats {
    return this.engine.metrics.snapshot();
  }

  /**
   * All messages in a conversation, oldest first. Fails if any listing or message could not be
   * retrieved; use `fetchMessages` to keep what was retrieved. Undecryptable bodies are skipped.
   */
  async getMessages(other: PeerKey, options: OperationOptions = {}): Promise<DecryptedMessage[]> {
    const fetch = await this.fetchMessages(other, options);
    const first = fetch.failures[0];
    if (first) {
      throw new Error(
        `Failed to retrieve ${fetch.failures.length} listing(s) or message(s), including ${describeFetchFailure(first)}`,
      );
    }
    return fetch.messages;
  }

  /** The messages that could be retrieved, and what could not. */
  async fetchMessages(other: PeerKey, options: OperationOptions = {}): Promise<MessageFetch> {
    return receiveMessages(this.engine, this.conversation(other), options.signal);
  }

  /**
   * The messages in a conversation that `state` has not acknowledged. Acknowledge each with
   * `state.acknowledge` once processed; unretrieved ones come back on the next call.
   */
  async receiveNewMessages(
    other: PeerKey,
    state: ReceiveState,
    options: OperationOptions = {},
  ): Promise<ReceivedMessages> {
    return receiveNew(this.engine, this.conversation(other), state, options.signal);
  }

  /**
   * List a conversation and return the messages `state` has not acknowledged, without
   * downloading them. Also drops acknowledgements for messages that are no longer listed.
   */
  async discoverMessages(
    other: PeerKey,
    state: ReceiveState,
    options: OperationOptions = {},
  ): Promise<Discovery> {
    return discover(this.engine, this.conversation(other), state, options.signal);
  }

  /** Download and decrypt messages returned by `discoverMessages`. */
  async retrieveMessages(
    other: PeerKey,
    pending: readonly PendingMessage[],
    options: OperationOptions = {},
  ): Promise<ReceivedMessages> {
    return retrieve(this.engine, this.conversation(other), pending, options.signal);
  }

  /** Delete a sent message by its ID, succeeding if it is already absent. */
  async deleteMessage(
    messageId: string,
    other: PeerKey,
    options: OperationOptions = {},
  ): Promise<void> {
    deletionResult(await this.deleteMessagesWithReport([messageId], other, options));
  }

  /**
   * Delete selected sent messages, succeeding if they are already absent. Every ID is validated
   * before requests begin, and all are attempted even if another fails.
   */
  async deleteMessages(
    messageIds: string[],
    other: PeerKey,
    options: OperationOptions = {},
  ): Promise<void> {
    deletionResult(await this.deleteMessagesWithReport(messageIds, other, options));
  }

  /**
   * Delete selected sent messages and report every outcome.
   *
   * IDs are the file names returned by `sendMessage`, without `.json`: nonempty, only ASCII
   * letters, digits, `-`, `.`, `_` or `~`, and not `.` or `..`. Invalid input throws before any
   * request. Duplicates are requested once. Only this client's files are removed. A 404 counts
   * as success, so a persisted cleanup job can retry safely. `deleted` holds full URLs.
   */
  async deleteMessagesWithReport(
    messageIds: readonly string[],
    other: PeerKey,
    options: OperationOptions = {},
  ): Promise<MessageDeletion> {
    const own = this.conversation(other).sides[0];
    return deleteMessages(this.engine, own, messageIds, options.signal);
  }

  /** Clear all sent messages in a conversation, failing if any listing or deletion fails. */
  async clearMessages(other: PeerKey, options: OperationOptions = {}): Promise<void> {
    deletionResult(await this.clearMessagesWithReport(other, options));
  }

  /**
   * Clear the sender's conversation directory and report each deletion or failure. Lists the
   * full directory before deleting anything; a failed listing deletes nothing. Messages
   * published after listing may remain. The recipient's storage is never modified.
   */
  async clearMessagesWithReport(
    other: PeerKey,
    options: OperationOptions = {},
  ): Promise<MessageDeletion> {
    const own = this.conversation(other).sides[0];
    return clearMessages(this.engine, own, options.signal);
  }

  // --- profiles and follows ---

  /** Get this client's own profile, or null if none exists. */
  async getOwnProfile(): Promise<PubkyProfile | null> {
    return this.fetchProfile(this.owner);
  }

  /** Get the users this client follows, with resolved profile names. */
  async getFollowedUsers(): Promise<FollowedUser[]> {
    return this.getFollowedUsersFor(this.owner);
  }

  /** Get the users a given `pubky` follows, with resolved profile names. */
  async getFollowedUsersFor(pubky: string): Promise<FollowedUser[]> {
    const followsDir = `pubky://${pubky}/pub/pubky.app/follows/`;
    let entries: string[];
    try {
      entries = await this.pubkyFacade.publicStorage.list(asAddress(followsDir));
    } catch {
      return [];
    }
    return Promise.all(
      entries.filter((e) => e !== '').map((entry) => this.getUserProfile(lastSegment(entry))),
    );
  }

  /** Follow a user by adding them to this client's follow list. */
  async putFollow(targetPubky: string): Promise<void> {
    const session = await this.sessionSource().current();
    await session.storage.putJson(asPath(`/pub/pubky.app/follows/${targetPubky}`), {
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /** Unfollow a user by removing them from this client's follow list. */
  async deleteFollow(targetPubky: string): Promise<void> {
    const session = await this.sessionSource().current();
    await session.storage.delete(asPath(`/pub/pubky.app/follows/${targetPubky}`));
  }

  private async getUserProfile(pubkyId: string): Promise<FollowedUser> {
    const profile = await this.fetchProfile(pubkyId);
    return profile ? { name: profile.name, pubky: pubkyId } : { pubky: pubkyId };
  }

  private async fetchProfile(pubky: string): Promise<PubkyProfile | null> {
    const address = `pubky://${pubky}/pub/pubky.app/profile.json`;
    try {
      const data: unknown = await this.pubkyFacade.publicStorage.getJson(asAddress(address));
      return isProfile(data) ? data : null;
    } catch {
      return null;
    }
  }
}

function isProfile(data: unknown): data is PubkyProfile {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  const optional = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string';
  return typeof d.name === 'string' && optional(d.bio) && optional(d.image) && optional(d.status);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Last non-empty path segment of a URL or path (the followee pubky / message filename). */
function lastSegment(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
