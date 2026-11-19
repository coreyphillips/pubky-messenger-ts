/**
 * A fair (FIFO) counting semaphore whose waiters can be cancelled, like `tokio::sync::Semaphore`.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, Math.floor(permits));
  }

  available(): number {
    return this.permits;
  }

  /** Wait for a permit. Resolves with a release function that must be called exactly once. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.permits > 0 && this.waiters.length === 0) {
      this.permits -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // The permit passes straight to the next waiter in line
        next.grant();
      } else {
        this.permits += 1;
      }
    };
  }
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Resolve after `ms`, or reject when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Settle with `promise`, or reject as soon as `signal` aborts. */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => {});
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
