/**
 * @file kv.ts — @myoxus/infra (storage)
 *
 * Binary key-value storage interfaces and in-memory implementations.
 *
 * The storage layer uses `Uint8Array` values to remain encoding-agnostic —
 * callers can store CRDT updates, serialised Y.Doc states, or arbitrary binary
 * blobs.
 *
 * Two interfaces are exported:
 * - {@link ByteKVBehavior} — the primitive read/write/delete contract.
 * - {@link ByteKV}         — extends `ByteKVBehavior` with transactional
 *   semantics; all writes are serialised inside `transaction()`.
 *
 * Two concrete implementations are exported:
 * - {@link MemoryByteKV}   — in-memory storage backed by a `Map`, with an
 *   {@link AsyncLock} for serialising transactions.
 * - {@link ReadonlyByteKV} — extends `MemoryByteKV` but silently drops all
 *   mutations; useful for read-only snapshots or test stubs.
 *
 * Consumers: storage sync engine in `client/libs/storage`; test utilities.
 */

import { AsyncLock } from "../utils";

/**
 * The primitive read/write/delete operations for a binary key-value store.
 *
 * Implementations may be synchronous or asynchronous (the interface accepts both).
 */
export interface ByteKVBehavior {
  /** Returns the stored value for `key`, or `null` if absent. */
  get(key: string): Promise<Uint8Array | null> | Uint8Array | null;
  /** Stores `value` under `key`, overwriting any existing entry. */
  set(key: string, value: Uint8Array): Promise<void> | void;
  /** Deletes the entry for `key`.  No-op when the key is absent. */
  del(key: string): Promise<void> | void;
  /** Returns all stored keys in unspecified order. */
  keys(): Promise<string[]> | string[];
  /** Removes all entries from the store. */
  clear(): Promise<void> | void;
}

/**
 * A transactional binary key-value store.
 *
 * Extends {@link ByteKVBehavior} with a `transaction` method that groups
 * operations into an atomic (serialised) unit.  Individual read/write methods
 * on the outer object are convenience wrappers that each open their own
 * single-operation transaction.
 */
export interface ByteKV extends ByteKVBehavior {
  /**
   * Runs `cb` inside a locked transaction.
   *
   * The `transaction` parameter passed to `cb` exposes the same
   * {@link ByteKVBehavior} interface but scoped to the lock window.
   * Concurrent calls to `transaction` are serialised — they queue and execute
   * one at a time.
   *
   * @param cb - Async callback that receives the transactional behavior handle.
   * @returns The value returned by `cb`.
   */
  transaction<T>(cb: (transaction: ByteKVBehavior) => Promise<T>): Promise<T>;
}

/**
 * In-memory implementation of {@link ByteKV} backed by a `Map<string, Uint8Array>`.
 *
 * All operations are serialised through an {@link AsyncLock} so concurrent
 * writes are safe.
 *
 * @example
 * ```ts
 * const kv = new MemoryByteKV();
 * await kv.set('doc:1', yUpdate);
 * const data = await kv.get('doc:1');
 * ```
 */
export class MemoryByteKV implements ByteKV {
  readonly lock = new AsyncLock();

  constructor(readonly db = new Map<string, Uint8Array>()) {}

  async transaction<T>(cb: (transaction: ByteKVBehavior) => Promise<T>) {
    using _lock = await this.lock.acquire();
    return await cb({
      get: async (key) => {
        return this.db.get(key) ?? null;
      },
      set: async (key, value) => {
        this.db.set(key, value);
      },
      keys: async () => {
        return Array.from(this.db.keys());
      },
      del: async (key) => {
        this.db.delete(key);
      },
      clear: async () => {
        this.db.clear();
      },
    });
  }

  get(key: string) {
    return this.transaction(async (tx) => tx.get(key));
  }

  set(key: string, value: Uint8Array) {
    return this.transaction(async (tx) => tx.set(key, value));
  }

  keys() {
    return this.transaction(async (tx) => tx.keys());
  }

  clear() {
    return this.transaction(async (tx) => tx.clear());
  }

  del(key: string) {
    return this.transaction(async (tx) => tx.del(key));
  }
}

/**
 * A read-only view over {@link MemoryByteKV} that silently discards all
 * mutation operations (`set`, `del`, `clear`).
 *
 * Useful for passing a KV store to code that may attempt writes but should
 * not be allowed to persist changes (e.g. read-only doc previews, test stubs).
 */
export class ReadonlyByteKV extends MemoryByteKV implements ByteKV {
  override transaction<T>(
    cb: (transaction: ByteKVBehavior) => Promise<T>,
  ): Promise<T> {
    return super.transaction((tx) => {
      return cb({
        ...tx,
        /** No-op: writes are silently discarded in a read-only store. */
        set() {
          return Promise.resolve();
        },
        /** No-op: deletions are silently discarded in a read-only store. */
        del() {
          return Promise.resolve();
        },
        /** No-op: clears are silently discarded in a read-only store. */
        clear() {
          return Promise.resolve();
        },
      });
    });
  }

  override set(_key: string, _value: Uint8Array): Promise<void> {
    return Promise.resolve();
  }

  override del(_key: string): Promise<void> {
    return Promise.resolve();
  }

  override clear(): Promise<void> {
    return Promise.resolve();
  }
}
