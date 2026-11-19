import { vi } from 'vitest';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Keypair } from '@synonymdev/pubky';
import { compareCodePoints, percentEncode, utf8 } from '../../src/bytes';
import { ConversationKey } from '../../src/crypto';
import { PrivateMessage } from '../../src/message';
import { StorageError, type ConditionalGetResult, type MessengerStorage } from '../../src/storage';

/**
 * Homeserver stand-in for unit tests, a port of the Rust crate's `FakeServer`: serves files and
 * paged listings with injected latency, and records concurrency, attempts and request counts.
 */

export type Reply =
  | { body: string }
  | { status: number }
  | { rateLimited: number }
  | 'hang'
  | 'broken'
  | 'storedThenBroken';

export interface ServerState {
  inFlight: number;
  peak: number;
  inFlightByConversation: Map<string, number>;
  peakByConversation: Map<string, number>;
  /** Attempts per URL, including the listing query. */
  attempts: Map<string, number>;
  starts: Array<[number, string]>;
  requests: number;
  listingRequests: number;
  messageRequests: number;
  bodiesSent: number;
  notModified: number;
  deleted: string[];
  putBodies: Array<[string, Uint8Array]>;
}

const freshState = (): ServerState => ({
  inFlight: 0,
  peak: 0,
  inFlightByConversation: new Map(),
  peakByConversation: new Map(),
  attempts: new Map(),
  starts: [],
  requests: 0,
  listingRequests: 0,
  messageRequests: 0,
  bodiesSent: 0,
  notModified: 0,
  deleted: [],
  putBodies: [],
});

export function keypair(seed: number): Keypair {
  return Keypair.fromSecret(new Uint8Array(32).fill(seed));
}

export function z32(kp: Keypair): string {
  return kp.publicKey.z32();
}

/** `owner`'s copy of the v1 conversation with `other`. */
export function directory(owner: Keypair, other: Keypair): string {
  const path = ConversationKey.derive(owner.secret(), other.publicKey.toUint8Array()).path();
  return `pubky://${z32(owner)}${path}`;
}

/** Entries a hostile homeserver could list in `owner`'s directory that do not name a file in it. */
export function entriesOutside(owner: Keypair, other: Keypair): string[] {
  const listed = directory(owner, other);
  const ownerKey = z32(owner);
  const path = listed.slice(`pubky://${ownerKey}`.length);
  return [
    'http://127.0.0.1:9/probe',
    'https://example.com/0000.json',
    `pubky://${ownerKey}@127.0.0.1:9${path}0000.json`,
    `pubky://${ownerKey}/pub/pubky.app/profile.json`,
    // The other participant's copy, and another conversation of the owner's
    `pubky://${z32(other)}${path}0000.json`,
    `${directory(owner, keypair(99))}0000.json`,
    listed,
    `${listed}.`,
    `${listed}..`,
    `${listed}../../pubky.app/profile.json`,
    `${listed}%2e%2e/%2e%2e/profile.json`,
    `${listed}..\\..\\profile.json`,
    `${listed}nested/0000.json`,
    `${listed}0000.json?probe`,
    `${listed}0000.json#probe`,
  ];
}

export function etagOf(body: string): string {
  return `"${bytesToHex(blake3(utf8(body)))}"`;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function hang(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function percentDecode(value: string): string {
  return decodeURIComponent(value);
}

export class FakeStorage {
  readonly routes = new Map<string, Reply[]>();
  readonly deleteRoutes = new Map<string, Reply[]>();
  readonly putRoutes = new Map<string, Reply[]>();
  readonly delays = new Map<string, number>();
  ignoresCursor = false;
  state: ServerState = freshState();
  private afterHook: { url: string; action: (server: FakeStorage) => void } | null = null;
  /** Leave out `getConditional`, like an adapter that cannot report entity tags. */
  withoutConditional = false;

  constructor(public latency = 0) {}

  /** Serve messages under `author`'s copy as `0000.json`, `0001.json`..., replacing that directory. */
  publish(author: Keypair, other: Keypair, messages: Array<[number, string]>): string[] {
    this.reply(directory(author, other), [{ body: '' }]);
    return messages.map(([timestamp, content], i) =>
      this.add(author, other, `${String(i).padStart(4, '0')}.json`, timestamp, content),
    );
  }

  /** Serve one more message under `author`'s copy of the conversation. */
  add(author: Keypair, other: Keypair, name: string, timestamp: number, content: string): string {
    const dir = directory(author, other);
    const url = `${dir}${name}`;
    const message = PrivateMessage.createAt(
      author.secret(),
      other.publicKey.toUint8Array(),
      content,
      timestamp,
    );
    this.reply(url, [{ body: message.serialize() }]);
    this.addEntry(dir, url);
    return url;
  }

  addEntry(dir: string, url: string): void {
    const entries = this.entries(dir);
    if (!entries.includes(url)) entries.push(url);
    this.reply(dir, [{ body: entries.join('\n') }]);
  }

  /** Delete a message and its listing entry. */
  remove(url: string): void {
    this.routes.delete(url);
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    this.reply(dir, [
      {
        body: this.entries(dir)
          .filter((e) => e !== url)
          .join('\n'),
      },
    ]);
  }

  /** Add entries to a directory's listing without serving anything at them. */
  listUnserved(dir: string, extra: string[]): void {
    this.reply(dir, [{ body: [...this.entries(dir), ...extra].join('\n') }]);
  }

  reply(url: string, replies: Reply[]): void {
    this.routes.set(url, replies);
  }

  replyDelete(url: string, replies: Reply[]): void {
    this.deleteRoutes.set(url, replies);
  }

  replyPut(url: string, replies: Reply[]): void {
    this.putRoutes.set(url, replies);
  }

  /** First reply body served at `url`. */
  body(url: string): string {
    const first = this.routes.get(url)?.[0];
    if (!first || typeof first !== 'object' || !('body' in first))
      throw new Error(`${url} has no body`);
    return first.body;
  }

  entries(dir: string): string[] {
    const first = this.routes.get(dir)?.[0];
    if (first && typeof first === 'object' && 'body' in first) {
      return first.body === '' ? [] : first.body.split('\n');
    }
    return [];
  }

  /** Run `action` once the request for `url` (including its listing query) completes. */
  afterRequest(url: string, action: (server: FakeStorage) => void): void {
    this.afterHook = { url, action };
  }

  attempts(url: string): number {
    return this.state.attempts.get(url) ?? 0;
  }

  startsOf(url: string): number[] {
    return this.state.starts.filter(([, u]) => u === url).map(([t]) => t);
  }

  /** Reset every count except attempts, which select replies. */
  resetCounts(): void {
    const attempts = this.state.attempts;
    this.state = freshState();
    this.state.attempts = attempts;
  }

  /** The adapter `owner` writes through: reads are public, writes land under `owner`. */
  storageFor(owner: string): MessengerStorage {
    const storage: MessengerStorage = {
      list: (dir, opts) => this.list(dir, opts),
      get: async (address, opts) => {
        const result = await this.get(address, undefined, opts?.signal);
        return result === null || result.notModified ? null : result.body;
      },
      put: (path, body, opts) => this.put(`pubky://${owner}${path}`, body, opts?.signal),
      delete: (path, opts) => this.delete(`pubky://${owner}${path}`, opts?.signal),
    };
    if (!this.withoutConditional) {
      storage.getConditional = (address, opts) => this.get(address, opts.ifNoneMatch, opts.signal);
    }
    return storage;
  }

  private begin(url: string): { attempt: number; end: () => void } {
    const after = url.split('/private_messages/')[1] ?? '';
    const segments = after.split('/');
    const conversation = (segments[0] === 'v2' ? segments[1] : segments[0]) ?? '';
    const s = this.state;
    s.requests += 1;
    if (url.split('?')[0]!.endsWith('/')) s.listingRequests += 1;
    else s.messageRequests += 1;
    s.inFlight += 1;
    s.peak = Math.max(s.peak, s.inFlight);
    const inConversation = (s.inFlightByConversation.get(conversation) ?? 0) + 1;
    s.inFlightByConversation.set(conversation, inConversation);
    s.peakByConversation.set(
      conversation,
      Math.max(s.peakByConversation.get(conversation) ?? 0, inConversation),
    );
    const attempt = (s.attempts.get(url) ?? 0) + 1;
    s.attempts.set(url, attempt);
    s.starts.push([Date.now(), url]);
    let ended = false;
    const state = this.state;
    return {
      attempt,
      end: () => {
        if (ended) return;
        ended = true;
        state.inFlight -= 1;
        state.inFlightByConversation.set(
          conversation,
          (state.inFlightByConversation.get(conversation) ?? 1) - 1,
        );
      },
    };
  }

  private pick(replies: Reply[] | undefined, attempt: number): Reply | undefined {
    if (!replies) return undefined;
    return replies[Math.min(attempt - 1, replies.length - 1)];
  }

  private runAfter(url: string): void {
    if (this.afterHook && this.afterHook.url === url) {
      const { action } = this.afterHook;
      this.afterHook = null;
      action(this);
    }
  }

  private failWith(reply: Reply): never {
    if (reply === 'broken' || reply === 'storedThenBroken') throw new Error('connection reset');
    if (typeof reply === 'object' && 'status' in reply) throw StorageError.fromStatus(reply.status);
    if (typeof reply === 'object' && 'rateLimited' in reply) {
      throw StorageError.fromStatus(429, { retryAfterMs: reply.rateLimited * 1000 });
    }
    throw new Error(`unexpected reply ${JSON.stringify(reply)}`);
  }

  async list(
    dir: string,
    { cursor, limit, signal }: { cursor?: string; limit: number; signal?: AbortSignal },
  ): Promise<string[]> {
    const key =
      cursor === undefined
        ? `${dir}?limit=${limit}`
        : `${dir}?limit=${limit}&cursor=${percentEncode(cursor)}`;
    const { attempt, end } = this.begin(key);
    try {
      await sleepFor(this.delays.get(dir) ?? this.latency, signal);
      const reply = this.pick(this.routes.get(dir), attempt) ?? { status: 404 };
      this.runAfter(key);
      if (reply === 'hang') return await hang(signal);
      if (typeof reply === 'object' && 'body' in reply) {
        const effectiveCursor = this.ignoresCursor
          ? undefined
          : cursor && percentDecode(percentEncode(cursor));
        const entries = (reply.body === '' ? [] : reply.body.split('\n')).sort(compareCodePoints);
        return entries
          .filter((e) => effectiveCursor === undefined || compareCodePoints(e, effectiveCursor) > 0)
          .slice(0, limit);
      }
      return this.failWith(reply);
    } finally {
      end();
    }
  }

  async get(
    url: string,
    ifNoneMatch: string | undefined,
    signal?: AbortSignal,
  ): Promise<ConditionalGetResult | null> {
    const { attempt, end } = this.begin(url);
    try {
      await sleepFor(this.delays.get(url) ?? this.latency, signal);
      const reply = this.pick(this.routes.get(url), attempt) ?? { status: 404 };
      this.runAfter(url);
      if (reply === 'hang') return await hang(signal);
      if (typeof reply === 'object' && 'body' in reply) {
        if (ifNoneMatch !== undefined && ifNoneMatch === etagOf(reply.body)) {
          this.state.notModified += 1;
          return { notModified: true };
        }
        this.state.bodiesSent += 1;
        return { notModified: false, body: utf8(reply.body), etag: etagOf(reply.body) };
      }
      if (typeof reply === 'object' && 'status' in reply && reply.status === 404) return null;
      return this.failWith(reply);
    } finally {
      end();
    }
  }

  async put(url: string, body: Uint8Array, signal?: AbortSignal): Promise<void> {
    const { attempt, end } = this.begin(url);
    try {
      this.state.putBodies.push([url, body.slice()]);
      await sleepFor(this.delays.get(url) ?? this.latency, signal);
      const reply = this.pick(this.putRoutes.get(url), attempt) ?? { status: 200 };
      if (reply === 'hang') return await hang(signal);
      const status =
        typeof reply === 'object' && 'status' in reply
          ? reply.status
          : reply === 'storedThenBroken'
            ? 200
            : -1;
      if (status >= 200 && status < 300) {
        this.reply(url, [{ body: new TextDecoder().decode(body) }]);
        this.addEntry(url.slice(0, url.lastIndexOf('/') + 1), url);
        if (reply === 'storedThenBroken') throw new Error('response lost after storage');
        return;
      }
      return this.failWith(reply);
    } finally {
      end();
    }
  }

  async delete(url: string, signal?: AbortSignal): Promise<void> {
    const { attempt, end } = this.begin(url);
    try {
      await sleepFor(this.delays.get(url) ?? this.latency, signal);
      const scripted = this.pick(this.deleteRoutes.get(url), attempt);
      const reply: Reply = scripted ?? (this.routes.has(url) ? { status: 200 } : { status: 404 });
      if (reply === 'hang') return await hang(signal);
      if (
        typeof reply === 'object' &&
        'status' in reply &&
        reply.status >= 200 &&
        reply.status < 300
      ) {
        this.remove(url);
        this.state.deleted.push(url);
        return;
      }
      // The adapter contract: a 404 resolves successfully
      if (typeof reply === 'object' && 'status' in reply && reply.status === 404) return;
      return this.failWith(reply);
    } finally {
      end();
    }
  }
}

/**
 * Drive fake timers until `promise` settles. Fails, instead of hanging, if it stalls with no
 * timer left to fire (a leaked permit, for example).
 */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let guard = 0; guard < 100_000 && !settled; guard++) {
    for (let i = 0; i < 20 && !settled; i++) await Promise.resolve();
    if (settled) break;
    if (vi.getTimerCount() === 0) {
      throw new Error('stalled: not settled and no timers pending');
    }
    await vi.advanceTimersToNextTimerAsync();
  }
  return promise;
}
