import { resolvePubky } from '@synonymdev/pubky';
import type { Address, Path, Pubky, Session } from '@synonymdev/pubky';
import { raceSignal } from './semaphore.js';

/**
 * Storage the messaging engine reads and writes through. Implement it to run the library on
 * any transport (a test double, a proxy, a different SDK version); `createPubkyStorage` is the
 * default adapter over `@synonymdev/pubky`.
 *
 * Errors should carry an HTTP status when one is known, so the engine can classify retries:
 * throw a `StorageError`, or any error with a numeric `status`, `statusCode` or
 * `data.statusCode` (the SDK's `PubkyError` shape). 429 and 5xx are retried, honoring
 * `retryAfterMs`; other statuses are not. An error without a status is a transport failure and
 * is retried. Set `authentication: true` when a write failed because a session could not be
 * established or was persistently rejected.
 *
 * Every method receives an `AbortSignal` that fires when the engine's per-attempt deadline
 * passes or the caller cancels. Honor it where the transport allows; the engine stops waiting
 * either way.
 */
export interface MessengerStorage {
  /** Public listing of a directory address `pubky://<owner>/<path>/`. Returns full `pubky://` entry addresses, one page. */
  list(
    dir: string,
    opts: { cursor?: string; limit: number; signal?: AbortSignal },
  ): Promise<string[]>;
  /** Public GET. Resolves null on 404. */
  get(address: string, opts?: { signal?: AbortSignal }): Promise<Uint8Array | null>;
  /** Write to the signed-in owner's storage at an absolute path like `/pub/...`. */
  put(path: string, body: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Delete from the owner's storage; a 404 must resolve successfully. */
  delete(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * Optional conditional public GET that reports entity tags. When present, incremental
   * receive uses it for every message body, so `ChangePolicy.Revalidate` can record tags and
   * recheck acknowledged messages with `If-None-Match`. Resolves null on 404.
   */
  getConditional?(
    address: string,
    opts: { ifNoneMatch?: string; signal?: AbortSignal },
  ): Promise<ConditionalGetResult | null>;
}

/** Result of `MessengerStorage.getConditional`. */
export type ConditionalGetResult =
  { notModified: true } | { notModified: false; body: Uint8Array; etag: string | null };

export interface StorageErrorOptions {
  /** HTTP status of the failed request, when one was received. */
  status?: number;
  /** A session could not be established, or the homeserver persistently rejected it. */
  authentication?: boolean;
  /** Wait requested by a `Retry-After` header, in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

/** A storage failure with the details the engine uses to classify it. */
export class StorageError extends Error {
  readonly status: number | undefined;
  readonly authentication: boolean;
  readonly retryAfterMs: number | undefined;

  /**
   * @param message Human-readable description.
   * @param options `status` (HTTP status, omit for transport failures), `authentication`,
   *   `retryAfterMs` and `cause`.
   */
  constructor(message: string, options: StorageErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.status = options.status;
    this.authentication = options.authentication ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** A failure answered with HTTP `status`. */
  static fromStatus(
    status: number,
    options: Omit<StorageErrorOptions, 'status'> & { message?: string } = {},
  ): StorageError {
    return new StorageError(options.message ?? `HTTP status ${status}`, { ...options, status });
  }
}

/** Parse a `Retry-After` header given in seconds, as the Rust crate does. */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header == null) return undefined;
  const trimmed = header.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : undefined;
}

/** What the engine reads from an error thrown by a storage adapter. */
export interface StorageErrorInfo {
  status: number | undefined;
  authentication: boolean;
  retryAfterMs: number | undefined;
  message: string;
}

const AUTH_ERROR_NAMES = new Set(['AuthenticationError', 'CredentialRefreshError']);

/**
 * Read the status and classification of an adapter error: a `StorageError`, an SDK
 * `PubkyError` (`name`, `message`, `data.statusCode`), or any error with `status`/`statusCode`.
 */
export function storageErrorInfo(error: unknown): StorageErrorInfo {
  if (error instanceof StorageError) {
    return {
      status: error.status,
      authentication: error.authentication,
      retryAfterMs: error.retryAfterMs,
      message: error.message,
    };
  }
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    data?: { statusCode?: unknown } | null;
    authentication?: unknown;
    retryAfterMs?: unknown;
  };
  const status = [e.status, e.statusCode, e.data?.statusCode].find(
    (s): s is number => typeof s === 'number' && Number.isInteger(s),
  );
  const name = typeof e.name === 'string' ? e.name : '';
  const message =
    typeof e.message === 'string' && e.message !== ''
      ? e.message
      : typeof error === 'string'
        ? error
        : String(error);
  return {
    status,
    // A grant refresh failure is a session failure; without a status it is a transport failure
    authentication:
      e.authentication === true || (AUTH_ERROR_NAMES.has(name) && status !== undefined),
    retryAfterMs: typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined,
    message:
      name && name !== 'Error' && !message.startsWith(name) ? `${name}: ${message}` : message,
  };
}

/** Convert any adapter-level error into a `StorageError`. */
export function toStorageError(
  error: unknown,
  extra: { authentication?: boolean } = {},
): StorageError {
  if (error instanceof StorageError && extra.authentication === undefined) return error;
  const info = storageErrorInfo(error);
  return new StorageError(info.message, {
    status: info.status,
    authentication: extra.authentication ?? info.authentication,
    retryAfterMs: info.retryAfterMs,
    cause: error,
  });
}

/** Where the default adapter gets the session it writes with. */
export interface SessionSource {
  /** The session to write with, establishing one if needed. */
  current(): Promise<Session>;
  /** Replace a session the homeserver rejected with 401. Omit to treat 401 as final. */
  renew?(stale: Session): Promise<Session>;
}

/**
 * Default adapter over `@synonymdev/pubky`.
 *
 * Reads and listings use `pubky.publicStorage`; writes and deletes use `session.storage`.
 * `getConditional` uses `pubky.client.fetch` on the resolved homeserver URL with
 * `If-None-Match`, and does not follow redirects. The SDK calls take no `AbortSignal`: on
 * abort the adapter stops waiting, but the request itself may still complete.
 *
 * @param session The signed-in session to write with, or a function returning it. Omit for a
 *   read-only adapter whose writes fail with an authentication error.
 */
export function createPubkyStorage(
  pubky: Pubky,
  session?: Session | (() => Promise<Session>),
): MessengerStorage {
  let source: SessionSource | null = null;
  if (typeof session === 'function') {
    source = { current: session };
  } else if (session) {
    const fixed = session;
    source = { current: () => Promise.resolve(fixed) };
  }
  return createPubkyStorageFrom(pubky, source);
}

/** Default adapter with a session source that can renew a rejected session once per write. */
export function createPubkyStorageFrom(
  pubky: Pubky,
  source: SessionSource | null,
): MessengerStorage {
  const obtain = async (get: () => Promise<Session>): Promise<Session> => {
    try {
      return await get();
    } catch (e) {
      const info = storageErrorInfo(e);
      // Failed session establishment keeps its status as an authentication failure
      throw toStorageError(e, { authentication: info.status !== undefined });
    }
  };

  const write = async (
    op: (session: Session) => Promise<void>,
    signal: AbortSignal | undefined,
    missingIsSuccess: boolean,
  ): Promise<void> => {
    if (!source) {
      throw new StorageError('Not signed in: no session to write with', {
        status: 401,
        authentication: true,
      });
    }
    const run = async (session: Session, final: boolean): Promise<void> => {
      try {
        await raceSignal(op(session), signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        const info = storageErrorInfo(e);
        if (missingIsSuccess && (info.status === 404 || info.status === 410)) return;
        if (info.status === 401 && !final) throw new RetryWithNewSession();
        throw toStorageError(e, { authentication: info.authentication || info.status === 401 });
      }
    };
    const session = await raceSignal(obtain(source.current), signal);
    try {
      await run(session, !source.renew);
    } catch (e) {
      if (!(e instanceof RetryWithNewSession)) throw e;
      // One coordinated refresh and one repeat per attempt; a second 401 is final
      const renewed = await raceSignal(
        obtain(() => source.renew!(session)),
        signal,
      );
      await run(renewed, true);
    }
  };

  return {
    async list(dir, { cursor, limit, signal }) {
      try {
        return await raceSignal(
          pubky.publicStorage.list(dir as Address, cursor ?? null, false, limit, false),
          signal,
        );
      } catch (e) {
        if (signal?.aborted) throw e;
        throw toStorageError(e);
      }
    },

    async get(address, opts) {
      try {
        return await raceSignal(pubky.publicStorage.getBytes(address as Address), opts?.signal);
      } catch (e) {
        if (opts?.signal?.aborted) throw e;
        const info = storageErrorInfo(e);
        if (info.status === 404 || info.status === 410) return null;
        throw toStorageError(e);
      }
    },

    async getConditional(address, { ifNoneMatch, signal }) {
      let response: Response;
      try {
        const headers: Record<string, string> = {};
        if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
        response = await raceSignal(
          pubky.client.fetch(resolvePubky(address), { headers, signal, redirect: 'manual' }),
          signal,
        );
      } catch (e) {
        if (signal?.aborted) throw e;
        throw toStorageError(e);
      }
      const status = response.status;
      if (status === 304) return { notModified: true };
      if (status === 404 || status === 410) return null;
      if (status >= 200 && status < 300) {
        const body = new Uint8Array(await raceSignal(response.arrayBuffer(), signal));
        return { notModified: false, body, etag: response.headers.get('etag') };
      }
      if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
        throw new StorageError('Redirect not followed', { status: status || 307 });
      }
      throw StorageError.fromStatus(status, {
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    },

    put(path, body, opts) {
      return write((s) => s.storage.putBytes(path as Path, body), opts?.signal, false);
    },

    delete(path, opts) {
      return write((s) => s.storage.delete(path as Path), opts?.signal, true);
    },
  };
}

class RetryWithNewSession extends Error {}
