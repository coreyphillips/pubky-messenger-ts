/**
 * Request counters without message contents, destinations or credentials. Ported from
 * `pubky-messenger` `src/metrics.rs`.
 */

/** Counters for one HTTP method or directory-listing operation. */
export interface RequestCounts {
  attempts: number;
  /** Body bytes offered to the storage adapter, including failed attempts. */
  requestBodyBytes: number;
  /** Body bytes of successful responses. Listings count their entries joined by newlines. */
  responseBodyBytes: number;
}

/**
 * Cumulative counters since client creation. Snapshots do not reset counters.
 *
 * Byte counts exclude HTTP headers, compression and TLS. Error response bodies are not
 * visible through the storage adapter and are not counted.
 */
export interface RequestStats {
  list: RequestCounts;
  get: RequestCounts;
  put: RequestCounts;
  delete: RequestCounts;
  session: RequestCounts;
  /** Additional attempts scheduled by the bounded request policy. */
  retries: number;
  timeouts: number;
  /** Aggregate admission wait across attempts in milliseconds, including cancelled waits. */
  queueWaitMs: number;
}

export type RequestKind = 'list' | 'get' | 'put' | 'delete' | 'session';

const KINDS: readonly RequestKind[] = ['list', 'get', 'put', 'delete', 'session'];

export class RequestMetrics {
  private readonly counts = new Map<RequestKind, RequestCounts>(
    KINDS.map((k) => [k, { attempts: 0, requestBodyBytes: 0, responseBodyBytes: 0 }]),
  );
  private retries = 0;
  private timeouts = 0;
  private queueWaitMs = 0;

  sent(kind: RequestKind, bytes: number): void {
    const c = this.counts.get(kind)!;
    c.attempts += 1;
    c.requestBodyBytes += bytes;
  }

  received(kind: RequestKind, bytes: number): void {
    this.counts.get(kind)!.responseBodyBytes += bytes;
  }

  retried(): void {
    this.retries += 1;
  }

  timedOut(): void {
    this.timeouts += 1;
  }

  queued(ms: number): void {
    this.queueWaitMs += Math.max(0, ms);
  }

  snapshot(): RequestStats {
    const copy = (k: RequestKind): RequestCounts => ({ ...this.counts.get(k)! });
    return {
      list: copy('list'),
      get: copy('get'),
      put: copy('put'),
      delete: copy('delete'),
      session: copy('session'),
      retries: this.retries,
      timeouts: this.timeouts,
      queueWaitMs: this.queueWaitMs,
    };
  }
}
