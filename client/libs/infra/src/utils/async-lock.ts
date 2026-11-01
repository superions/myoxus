/**
 * @file async-lock.ts — @myoxus/infra (utils)
 *
 * A simple async mutual-exclusion lock for JavaScript.
 *
 * Useful when multiple concurrent async operations must not overlap on a shared
 * resource (e.g. sequential database writes, token refresh flows).
 *
 * Compatible with the TC39 `using` declaration (TypeScript 5.2+):
 * ```ts
 * const lock = new AsyncLock();
 * using _lock = await lock.acquire();
 * // critical section here — lock is released when `_lock` goes out of scope
 * ```
 *
 * Consumers: {@link MemoryByteKV} in `storage/kv.ts`; any module that needs
 * sequential async execution.
 */

/**
 * A non-reentrant async mutex lock.
 *
 * Calls to `acquire` are queued; each call resolves only after the previous
 * lock holder has called `release` (or the `using` block exits).
 *
 * Note: this lock is NOT reentrant.  Acquiring it twice from the same async
 * context without releasing first will deadlock.
 */
export class AsyncLock {
  private _lock: Promise<void> | null = null;

  /**
   * Acquires the lock, waiting until it is free if another holder is active.
   *
   * @returns An object with:
   *   - `release()` — a function to release the lock explicitly.
   *   - `[Symbol.dispose]` — allows the lock to be released automatically
   *     via a `using` declaration.
   *
   * @example
   * ```ts
   * const lock = new AsyncLock();
   *
   * // Manual release
   * const { release } = await lock.acquire();
   * try { ... } finally { release(); }
   *
   * // Using TC39 'using'
   * using _lock = await lock.acquire();
   * // lock released at end of block
   * ```
   */
  async acquire() {
    let release: (() => void) | null = null;
    const nextLock = new Promise<void>((resolve) => {
      release = () => {
        this._lock = null;
        resolve();
      };
    });

    // Atomic check and set of lock state
    const currentLock = this._lock;
    this._lock = nextLock;

    if (currentLock) {
      await currentLock;
    }

    return {
      /** Releases this lock, allowing the next waiter to proceed. */
      release: () => {
        if (release) {
          release();
          release = null;
        }
      },
      /** TC39 `[Symbol.dispose]` — releases the lock when a `using` block exits. */
      [Symbol.dispose]: () => {
        if (release) {
          release();
          release = null;
        }
      },
    };
  }
}
