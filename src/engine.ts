import { compareCodePoints, isUnreservedName, percentEncode, utf8 } from './bytes.js';
import { RequestMetrics, type RequestKind } from './metrics.js';
import { Semaphore, abortReason, sleep } from './semaphore.js';
import { storageErrorInfo, type MessengerStorage } from './storage.js';

/**
 * Concurrency limits, deadlines and retry policy for conversation storage operations. Ported
 * from `pubky-messenger` `src/receive.rs`.
 *
 * Each listing or message request holds a permit from its call and one from the client while
 * it is in flight. Permits are released when the attempt completes, times out, fails or is
 * cancelled, and are not held while waiting to retry.
 *
 * An attempt that times out, fails before a response arrives, or gets a 429 or 5xx status is
 * retried until `maxAttempts` have been made. Retry `n` waits `retryBaseDelayMs * 2^(n-1)`,
 * capped at `maxRetryDelayMs`. A `Retry-After` reported by the adapter replaces that wait, and
 * if it asks for longer than `maxRetryDelayMs` the request is not retried. Other statuses are
 * not retried. A 404 is successful for reads and deletions, but fails publication. Failed
 * session establishment keeps its status as an authentication failure, including 404. Cleanup
 * uses at most half the client slots (minimum one), leaving foreground capacity. Queue wait,
 * backoff and the total operation are outside each attempt's deadline; callers may cancel with
 * an `AbortSignal` and retry a saved prepared message or cleanup batch.
 *
 * Limits and attempts below 1 are treated as 1.
 */
export interface FetchConfig {
  /** Storage attempts in flight across every conversation on this client. */
  maxConcurrentRequests: number;
  /** Requests in flight for one call that reads, publishes or deletes conversation messages. */
  maxConcurrentRequestsPerConversation: number;
  /** Deadline for one attempt, from sending the request to reading the whole body. */
  requestTimeoutMs: number;
  /** Attempts per request, including the first. */
  maxAttempts: number;
  /** Wait before the first retry, doubled for each later one. */
  retryBaseDelayMs: number;
  /** Longest wait before a retry. */
  maxRetryDelayMs: number;
  /**
   * Entries requested per page of a directory listing. A listing is read until the homeserver
   * returns an empty page, because it may return fewer entries than requested before the end.
   */
  listPageSize: number;
  /**
   * Entries one directory listing may hold before it fails, so a homeserver that keeps
   * returning new pages cannot keep a read going forever.
   */
  maxListingEntries: number;
}

export const DEFAULT_FETCH_CONFIG: Readonly<FetchConfig> = Object.freeze({
  maxConcurrentRequests: 16,
  maxConcurrentRequestsPerConversation: 8,
  requestTimeoutMs: 10_000,
  maxAttempts: 3,
  retryBaseDelayMs: 500,
  maxRetryDelayMs: 10_000,
  // Pubky homeservers cap pages at 1000 entries
  listPageSize: 1000,
  maxListingEntries: 100_000,
});

/** Fill unspecified fields of `partial` from `DEFAULT_FETCH_CONFIG`. */
export function resolveFetchConfig(partial: Partial<FetchConfig> = {}): FetchConfig {
  const config: FetchConfig = { ...DEFAULT_FETCH_CONFIG };
  for (const [key, value] of Object.entries(partial) as Array<[keyof FetchConfig, unknown]>) {
    if (value === undefined) continue;
    if (!(key in DEFAULT_FETCH_CONFIG)) throw new Error(`Unknown FetchConfig field: ${key}`);
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      throw new Error(`Invalid FetchConfig.${key}: ${String(value)}`);
    }
    config[key] = value;
  }
  return config;
}

/** Why a listing or message request did not complete successfully. */
export type FailureReason =
  /** Unsuccessful HTTP status; 429 means rate limited. */
  | { kind: 'status'; status: number }
  /** Authentication failed before the mutation could be confirmed. */
  | { kind: 'authentication'; status: number }
  /** No complete response within `requestTimeoutMs`. */
  | { kind: 'timedOut' }
  /** The request failed before a response arrived. */
  | { kind: 'transport'; message: string }
  /** A listing page did not advance past the previous page, so paging would never end. */
  | { kind: 'listingStalled' }
  /** A listing held more than `maxListingEntries` entries. */
  | { kind: 'listingTooLong' }
  /** The URL is not a file directly inside its publisher's copy of the conversation, so it was not requested. */
  | { kind: 'outsideConversation' };

/** A directory listing or message request that did not complete successfully. */
export interface FetchFailure {
  url: string;
  /** Attempts made before giving up. */
  attempts: number;
  /** Why the last attempt failed. */
  reason: FailureReason;
}

/** One-line description of a failure, the same text the Rust crate displays. */
export function describeFetchFailure(failure: FetchFailure): string {
  const r = failure.reason;
  const reason =
    r.kind === 'status'
      ? `status ${r.status}`
      : r.kind === 'authentication'
        ? `authentication status ${r.status}`
        : r.kind === 'timedOut'
          ? 'timed out'
          : r.kind === 'transport'
            ? r.message
            : r.kind === 'listingStalled'
              ? 'listing did not advance'
              : r.kind === 'listingTooLong'
                ? 'listing exceeded maxListingEntries'
                : 'not a message in this conversation, not requested';
  const attempts = failure.attempts > 0 ? ` after ${failure.attempts} attempt(s)` : '';
  return `${failure.url}: ${reason}${attempts}`;
}

/** Thrown by operations that fail as a whole because of one request, such as publication. */
export class FetchFailureError extends Error {
  constructor(readonly failure: FetchFailure) {
    super(describeFetchFailure(failure));
    this.name = 'FetchFailureError';
  }
}

/** Client-wide admission: every attempt takes a `total` permit, cleanup also a `cleanup` one. */
export class RequestBudget {
  readonly total: Semaphore;
  readonly cleanup: Semaphore;

  constructor(limit: number) {
    const permits = Math.max(1, Math.floor(limit));
    this.total = new Semaphore(permits);
    this.cleanup = new Semaphore(Math.max(1, Math.floor(permits / 2)));
  }

  available(): number {
    return this.total.available();
  }
}

/** Everything a request needs: the adapter, the policy, the shared budget and the counters. */
export interface EngineContext {
  storage: MessengerStorage;
  config: FetchConfig;
  budget: RequestBudget;
  metrics: RequestMetrics;
}

export function createEngine(
  storage: MessengerStorage,
  config: Partial<FetchConfig> = {},
): EngineContext {
  const resolved = resolveFetchConfig(config);
  return {
    storage,
    config: resolved,
    budget: new RequestBudget(resolved.maxConcurrentRequests),
    metrics: new RequestMetrics(),
  };
}

export type Resource =
  | { kind: 'found'; body: Uint8Array; etag: string | null }
  | { kind: 'notModified' }
  | { kind: 'missing' };

export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: FetchFailure };

type Operation =
  | { kind: 'list'; dir: string; cursor: string | undefined; limit: number }
  | { kind: 'get'; conditional: boolean; ifNoneMatch: string | undefined }
  | { kind: 'delete' }
  | { kind: 'put'; body: Uint8Array };

type Success =
  | { kind: 'entries'; entries: string[] }
  | { kind: 'resource'; resource: Resource }
  | { kind: 'done' };

type Attempt =
  { kind: 'ok'; value: Success } | { kind: 'error'; error: unknown } | { kind: 'timedOut' };

const now = (): number => Date.now();

/**
 * Requests made by one call (one conversation read, publication or cleanup), sharing the
 * client budget and limited by the per-conversation permits.
 */
export class Requests {
  private readonly conversation: Semaphore;
  private readonly cleanup: boolean;
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly ctx: EngineContext,
    options: { cleanup?: boolean; signal?: AbortSignal } = {},
  ) {
    this.conversation = new Semaphore(ctx.config.maxConcurrentRequestsPerConversation);
    this.cleanup = options.cleanup ?? false;
    this.signal = options.signal;
  }

  /**
   * Every entry of the directory at `dir`, in the homeserver's order, or null if the directory
   * does not exist. Entries are whatever the homeserver sent: filter them with `messageUrls`
   * before requesting any. Entries published while paging may be missed if they sort before
   * the cursor.
   */
  async list(dir: string): Promise<Outcome<string[] | null>> {
    const config = this.ctx.config;
    const limit = Math.max(1, Math.floor(config.listPageSize));
    const entries: string[] = [];

    for (;;) {
      const cursor = entries.length > 0 ? entries[entries.length - 1] : undefined;
      const pageUrl =
        cursor === undefined
          ? `${dir}?limit=${limit}`
          : `${dir}?limit=${limit}&cursor=${percentEncode(cursor)}`;
      const result = await this.request(pageUrl, { kind: 'list', dir, cursor, limit });
      if (!result.ok) return result;
      const value = result.value;
      if (value.kind !== 'entries') {
        // Missing: no directory, or emptied while paging
        if (entries.length === 0) return { ok: true, value: null };
        break;
      }
      const page = value.entries.filter((entry) => entry !== '');
      const last = page[page.length - 1];
      if (last === undefined) break;
      if (cursor !== undefined && compareCodePoints(last, cursor) <= 0) {
        return {
          ok: false,
          failure: { url: pageUrl, attempts: 1, reason: { kind: 'listingStalled' } },
        };
      }
      entries.push(...page);
      if (entries.length > config.maxListingEntries) {
        return {
          ok: false,
          failure: { url: pageUrl, attempts: 1, reason: { kind: 'listingTooLong' } },
        };
      }
    }
    return { ok: true, value: entries };
  }

  /**
   * The resource at `url`. With `conditional`, uses the adapter's `getConditional` when it has
   * one, so the entity tag is reported and `ifNoneMatch` can answer "not modified".
   */
  async retrieve(
    url: string,
    options: { conditional?: boolean; ifNoneMatch?: string } = {},
  ): Promise<Outcome<Resource>> {
    const result = await this.request(url, {
      kind: 'get',
      conditional: options.conditional ?? false,
      ifNoneMatch: options.ifNoneMatch,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value.kind === 'resource' ? result.value.resource : { kind: 'missing' },
    };
  }

  /** Delete a message, including one an earlier attempt already removed. */
  async delete(url: string): Promise<Outcome<void>> {
    const result = await this.request(url, { kind: 'delete' });
    return result.ok ? { ok: true, value: undefined } : result;
  }

  /** Store `body` at `url`; a 404 is a failure here. */
  async publish(url: string, body: Uint8Array): Promise<Outcome<void>> {
    const result = await this.request(url, { kind: 'put', body });
    return result.ok ? { ok: true, value: undefined } : result;
  }

  private async request(url: string, op: Operation): Promise<Outcome<Success>> {
    const config = this.ctx.config;
    const maxAttempts = Math.max(1, Math.floor(config.maxAttempts));
    let attempts = 0;

    for (;;) {
      attempts += 1;
      const attempt = await this.attempt(url, op);
      let reason: FailureReason;
      let retryAfterMs: number | undefined;

      if (attempt.kind === 'ok') {
        return { ok: true, value: attempt.value };
      } else if (attempt.kind === 'timedOut') {
        this.ctx.metrics.timedOut();
        reason = { kind: 'timedOut' };
      } else {
        const info = storageErrorInfo(attempt.error);
        retryAfterMs = info.retryAfterMs;
        if (info.authentication) {
          reason = { kind: 'authentication', status: info.status ?? 401 };
        } else if (info.status === undefined) {
          reason = { kind: 'transport', message: info.message };
          retryAfterMs = undefined;
        } else if (info.status === 304 && op.kind === 'get') {
          return { ok: true, value: { kind: 'resource', resource: { kind: 'notModified' } } };
        } else if ((info.status === 404 || info.status === 410) && op.kind !== 'put') {
          return {
            ok: true,
            value:
              op.kind === 'get' || op.kind === 'list'
                ? { kind: 'resource', resource: { kind: 'missing' } }
                : { kind: 'done' },
          };
        } else {
          reason = { kind: 'status', status: info.status };
        }
      }

      let delay: number | null;
      if (
        (reason.kind === 'status' || reason.kind === 'authentication') &&
        !isRetryable(reason.status)
      ) {
        delay = null;
      } else if (retryAfterMs !== undefined) {
        delay = retryAfterMs <= config.maxRetryDelayMs ? retryAfterMs : null;
      } else {
        delay = this.backoff(attempts);
      }

      if (delay !== null && attempts < maxAttempts) {
        await sleep(delay, this.signal);
        this.ctx.metrics.retried();
      } else {
        return { ok: false, failure: { url, attempts, reason } };
      }
    }
  }

  private async attempt(url: string, op: Operation): Promise<Attempt> {
    const since = now();
    const releases: Array<() => void> = [];
    try {
      // Cleanup takes its reservation before joining the shared FIFO queue, so at most half
      // the total slots can be held by cleanup when the client has several.
      if (this.cleanup || op.kind === 'delete') {
        releases.push(await this.ctx.budget.cleanup.acquire(this.signal));
      }
      releases.push(await this.conversation.acquire(this.signal));
      releases.push(await this.ctx.budget.total.acquire(this.signal));
    } catch (e) {
      this.ctx.metrics.queued(now() - since);
      for (const release of releases.reverse()) release();
      throw e;
    }
    this.ctx.metrics.queued(now() - since);
    try {
      return await this.withDeadline(url, op);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async withDeadline(url: string, op: Operation): Promise<Attempt> {
    const outer = this.signal;
    if (outer?.aborted) throw abortReason(outer);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const call = this.call(url, op, controller.signal).then(
      (value): Attempt => ({ kind: 'ok', value }),
      (error: unknown): Attempt => ({ kind: 'error', error }),
    );
    const deadline = new Promise<Attempt>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timedOut' }), this.ctx.config.requestTimeoutMs);
    });
    const cancelled = new Promise<'aborted'>((resolve) => {
      if (!outer) return;
      onAbort = () => resolve('aborted');
      outer.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const result = await Promise.race([call, deadline, cancelled]);
      if (result === 'aborted') {
        controller.abort(abortReason(outer!));
        throw abortReason(outer!);
      }
      if (result.kind === 'timedOut') {
        controller.abort(new DOMException('Attempt deadline passed', 'TimeoutError'));
      }
      return result;
    } finally {
      clearTimeout(timer);
      if (onAbort) outer?.removeEventListener('abort', onAbort);
    }
  }

  private async call(url: string, op: Operation, signal: AbortSignal): Promise<Success> {
    const { storage, metrics } = this.ctx;
    const kind: RequestKind = op.kind;
    switch (op.kind) {
      case 'list': {
        metrics.sent(kind, 0);
        const entries = await storage.list(op.dir, { cursor: op.cursor, limit: op.limit, signal });
        metrics.received(kind, utf8(entries.join('\n')).length);
        return { kind: 'entries', entries };
      }
      case 'get': {
        metrics.sent(kind, 0);
        if (op.conditional && storage.getConditional) {
          const result = await storage.getConditional(url, { ifNoneMatch: op.ifNoneMatch, signal });
          if (result === null) return { kind: 'resource', resource: { kind: 'missing' } };
          if (result.notModified) return { kind: 'resource', resource: { kind: 'notModified' } };
          metrics.received(kind, result.body.length);
          return {
            kind: 'resource',
            resource: { kind: 'found', body: result.body, etag: result.etag },
          };
        }
        const body = await storage.get(url, { signal });
        if (body === null) return { kind: 'resource', resource: { kind: 'missing' } };
        metrics.received(kind, body.length);
        return { kind: 'resource', resource: { kind: 'found', body, etag: null } };
      }
      case 'delete':
        metrics.sent(kind, 0);
        await storage.delete(ownPath(url), { signal });
        return { kind: 'done' };
      case 'put':
        metrics.sent(kind, op.body.length);
        await storage.put(ownPath(url), op.body, { signal });
        return { kind: 'done' };
    }
  }

  private backoff(attempts: number): number {
    const factor = 2 ** Math.min(attempts - 1, 31);
    return Math.min(this.ctx.config.retryBaseDelayMs * factor, this.ctx.config.maxRetryDelayMs);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Absolute path of a `pubky://<owner>/...` URL in its owner's storage. */
export function ownPath(url: string): string {
  if (!url.startsWith('pubky://')) throw new Error(`Not a pubky:// URL: ${url}`);
  const rest = url.slice('pubky://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) throw new Error(`No path in ${url}`);
  return rest.slice(slash);
}

/**
 * Whether `url` names a file directly inside `directory`. The name is limited to unreserved
 * characters, so it cannot leave the directory through a separator, dot segment, percent
 * escape, query or fragment.
 */
export function isMessageUrl(directory: string, url: string): boolean {
  if (!url.startsWith(directory)) return false;
  const name = url.slice(directory.length);
  return name !== '.' && name !== '..' && isUnreservedName(name);
}

export function outsideConversation(url: string): FetchFailure {
  return { url, attempts: 0, reason: { kind: 'outsideConversation' } };
}

/**
 * Split the entries listed for `directory` into the URLs of files directly inside it, and
 * failures for everything else, which must not be requested.
 */
export function messageUrls(
  directory: string,
  entries: string[],
): { urls: string[]; outside: FetchFailure[] } {
  const urls: string[] = [];
  const outside: FetchFailure[] = [];
  for (const entry of entries) {
    if (isMessageUrl(directory, entry)) urls.push(entry);
    else outside.push(outsideConversation(entry));
  }
  return { urls, outside };
}

/** The file name of a message URL without its `.json` extension: the message UUID. */
export function messageUuid(id: { url: string } | string): string {
  const url = typeof id === 'string' ? id : id.url;
  const name = url.slice(url.lastIndexOf('/') + 1);
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}
