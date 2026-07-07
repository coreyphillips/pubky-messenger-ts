import { Keypair, PublicKey, Pubky } from '@synonymdev/pubky';
import type { Address, Path, Session, SessionStorage } from '@synonymdev/pubky';
import { validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { generateConversationPath } from './crypto.js';
import { PrivateMessage, type DecryptedMessage } from './message.js';

/** Profile information stored under the `pubky.app` app namespace. */
export interface PubkyProfile {
  name: string;
  bio?: string;
  image?: string;
  status?: string;
}

/** A user that is being followed. */
export interface FollowedUser {
  name?: string;
  pubky: string;
}

/** A BIP39 wordlist (from `@scure/bip39/wordlists/*`). */
export type Wordlist = string[];

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;
const RATE_LIMIT_RETRY_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const asPath = (p: string): Path => p as Path;
const asAddress = (a: string): Address => a as Address;

/**
 * Client for end-to-end encrypted private messaging over the Pubky network.
 *
 * A faithful TypeScript port of the Rust `PrivateMessengerClient`. Writes and
 * deletes go through the authenticated session storage (the caller's own space);
 * reads and directory listings go through public storage (any user's `/pub` data).
 */
export class PrivateMessengerClient {
  private readonly pubky: Pubky;
  private readonly keypair: Keypair;
  private session: Session | null = null;

  /** Create a client from a keypair. */
  constructor(keypair: Keypair) {
    this.keypair = keypair;
    this.pubky = new Pubky();
  }

  /**
   * Create a client from a `.pkarr` recovery file.
   * @param passphrase Defaults to an empty string.
   */
  static fromRecoveryFile(recoveryFileBytes: Uint8Array, passphrase = ''): PrivateMessengerClient {
    const keypair = Keypair.fromRecoveryFile(recoveryFileBytes, passphrase);
    return new PrivateMessengerClient(keypair);
  }

  /**
   * Create a client from a 12-word BIP39 recovery phrase.
   *
   * The Ed25519 secret is the first 32 bytes of the BIP39 seed (no derivation
   * path), matching the Rust implementation.
   * @param passphrase Optional BIP39 passphrase (defaults to an empty string).
   * @param wordlist Optional BIP39 wordlist (defaults to English).
   */
  static fromRecoveryPhrase(
    mnemonicPhrase: string,
    passphrase = '',
    wordlist: Wordlist = englishWordlist,
  ): PrivateMessengerClient {
    const normalized = mnemonicPhrase.trim().replace(/\s+/g, ' ');
    if (!validateMnemonic(normalized, wordlist)) {
      throw new Error('Invalid mnemonic phrase');
    }
    const seed = mnemonicToSeedSync(normalized, passphrase);
    const keypair = Keypair.fromSecret(seed.slice(0, 32));
    return new PrivateMessengerClient(keypair);
  }

  /** Sign in to the homeserver. Required before sending or deleting. */
  async signIn(): Promise<Session> {
    const signer = this.pubky.signer(this.keypair);
    this.session = await signer.signin();
    return this.session;
  }

  /** This client's public key. */
  publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  /** This client's public key as a z-base32 string. */
  publicKeyString(): string {
    return this.keypair.publicKey.z32();
  }

  /** Send an encrypted message to `recipient`. Returns the new message ID. */
  async sendMessage(recipient: PublicKey, content: string): Promise<string> {
    const message = PrivateMessage.create(this.keypair, recipient, content);
    const msgId = PrivateMessage.generateId();
    const convPath = generateConversationPath(this.keypair, recipient);
    await this.storage().putText(asPath(`${convPath}${msgId}.json`), message.serialize());
    return msgId;
  }

  /**
   * Get all messages in the conversation with `other`, sorted by timestamp ascending.
   *
   * Lists both participants' conversation directories, fetches and decrypts each
   * message, and verifies its signature (best-effort: unverifiable messages are
   * still returned with `verified: false`). Entries that fail to fetch or decrypt
   * are skipped.
   */
  async getMessages(other: PublicKey): Promise<DecryptedMessage[]> {
    const convPath = generateConversationPath(this.keypair, other);
    const selfDir = `pubky://${this.keypair.publicKey.z32()}${convPath}`;
    const otherDir = `pubky://${other.z32()}${convPath}`;

    const urls = [...(await this.list(selfDir)), ...(await this.list(otherDir))];

    const messages: DecryptedMessage[] = [];
    for (const url of urls) {
      try {
        const text = await this.pubky.publicStorage.getText(asAddress(url));
        const pm = PrivateMessage.deserialize(text);
        const content = pm.decryptContent(this.keypair, other);
        const sender = pm.decryptSender(this.keypair, other);
        let verified = false;
        try {
          verified = pm.verifySignature(content, sender);
        } catch {
          verified = false;
        }
        messages.push({ sender, content, timestamp: pm.timestamp, verified });
      } catch {
        // Skip entries that fail to fetch or decrypt.
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  /** Delete a single message by ID from the conversation with `other`. */
  async deleteMessage(messageId: string, other: PublicKey): Promise<void> {
    const convPath = generateConversationPath(this.keypair, other);
    await this.storage().delete(asPath(`${convPath}${messageId}.json`));
  }

  /** Delete multiple messages by ID (in parallel) from the conversation with `other`. */
  async deleteMessages(messageIds: string[], other: PublicKey): Promise<void> {
    const convPath = generateConversationPath(this.keypair, other);
    await Promise.all(
      messageIds.map(async (id) => {
        try {
          await this.storage().delete(asPath(`${convPath}${id}.json`));
        } catch (e) {
          throw new Error(`Failed to delete message ${id}: ${errorMessage(e)}`);
        }
      }),
    );
  }

  /**
   * Clear all of this client's own sent messages in the conversation with `other`.
   *
   * Only removes the caller's own copies (the other party's stored copies remain).
   * Deletes in batches to avoid rate limiting, retrying once on HTTP 429.
   */
  async clearMessages(other: PublicKey): Promise<void> {
    const convPath = generateConversationPath(this.keypair, other);
    const selfDir = `pubky://${this.keypair.publicKey.z32()}${convPath}`;

    const urls = await this.list(selfDir);
    if (urls.length === 0) {
      return;
    }

    const paths = urls.map((url) => asPath(`${convPath}${lastSegment(url)}`));
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((p) => this.deleteWithRetry(p)));
      if (batch.length === BATCH_SIZE) {
        await sleep(BATCH_DELAY_MS);
      }
    }
  }

  /** Get this client's own profile, or `null` if none exists. */
  async getOwnProfile(): Promise<PubkyProfile | null> {
    return this.fetchProfile(this.keypair.publicKey.z32());
  }

  /** Get the users this client follows, with resolved profile names. */
  async getFollowedUsers(): Promise<FollowedUser[]> {
    return this.getFollowedUsersFor(this.keypair.publicKey.z32());
  }

  /** Get the users a given `pubky` follows, with resolved profile names. */
  async getFollowedUsersFor(pubky: string): Promise<FollowedUser[]> {
    const followsDir = `pubky://${pubky}/pub/pubky.app/follows/`;
    const entries = await this.list(followsDir);
    return Promise.all(entries.map((entry) => this.getUserProfile(lastSegment(entry))));
  }

  /** Follow a user by adding them to this client's follow list. */
  async putFollow(targetPubky: string): Promise<void> {
    const createdAt = Math.floor(Date.now() / 1000);
    await this.storage().putJson(asPath(`/pub/pubky.app/follows/${targetPubky}`), {
      created_at: createdAt,
    });
  }

  /** Unfollow a user by removing them from this client's follow list. */
  async deleteFollow(targetPubky: string): Promise<void> {
    await this.storage().delete(asPath(`/pub/pubky.app/follows/${targetPubky}`));
  }

  // --- internal helpers ---

  private storage(): SessionStorage {
    if (!this.session) {
      throw new Error('Not signed in. Call signIn() first.');
    }
    return this.session.storage;
  }

  /** List a public directory, returning fully-qualified `pubky://` addresses. */
  private async list(dirAddress: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await this.pubky.publicStorage.list(asAddress(dirAddress));
    } catch {
      return [];
    }
    return entries.map((entry) => toAddress(entry, dirAddress));
  }

  private async deleteWithRetry(path: Path): Promise<void> {
    try {
      await this.storage().delete(path);
    } catch (e) {
      if (isRateLimit(e)) {
        await sleep(RATE_LIMIT_RETRY_MS);
        await this.storage().delete(path);
        return;
      }
      throw e;
    }
  }

  private async getUserProfile(pubkyId: string): Promise<FollowedUser> {
    const profile = await this.fetchProfile(pubkyId);
    return profile ? { name: profile.name, pubky: pubkyId } : { pubky: pubkyId };
  }

  private async fetchProfile(pubky: string): Promise<PubkyProfile | null> {
    const address = `pubky://${pubky}/pub/pubky.app/profile.json`;
    try {
      const data: unknown = await this.pubky.publicStorage.getJson(asAddress(address));
      if (
        data &&
        typeof data === 'object' &&
        typeof (data as { name?: unknown }).name === 'string'
      ) {
        return data as PubkyProfile;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRateLimit(e: unknown): boolean {
  const msg = errorMessage(e);
  return msg.includes('429') || /rate.?limit/i.test(msg) || /too many requests/i.test(msg);
}

/** Last non-empty path segment of a URL or path (the followee pubky / message filename). */
function lastSegment(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Resolve a directory-listing entry to a fully-qualified `pubky://` address. */
function toAddress(entry: string, dirAddress: string): string {
  if (entry.startsWith('pubky')) {
    // Already an address (`pubky://<user>/...` or the `pubky<user>/...` form).
    return entry;
  }
  if (entry.startsWith('/')) {
    // Absolute path under some host, reuse the host from the listed directory.
    const host = dirAddress.replace(/^pubky:\/\//, '').split('/')[0];
    return `pubky://${host}${entry}`;
  }
  // Bare filename within the listed directory.
  return `${dirAddress}${entry}`;
}
