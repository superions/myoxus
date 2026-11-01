/**
 * @file object-pool.ts — @myoxus/infra (utils)
 *
 * Reference-counted object pool with lazy garbage collection.
 *
 * Objects are stored in a `Map<Key, { obj, rc }>`.  Each {@link RcRef} returned
 * by `get` or `put` holds a reference count.  When all refs for a key are
 * released (rc → 0), the GC timer fires after 1 second and removes unreferenced
 * entries (optionally consulting `onDangling` to defer removal).
 *
 * Supports the TC39 `using` declaration via `[Symbol.dispose]`:
 * ```ts
 * using ref = pool.get(key) ?? pool.put(key, createObj());
 * // ref is released when the block exits
 * ```
 *
 * Consumers: workspace and document managers in `client/web` that pool
 * expensive resources like Y.Doc instances or network connections.
 */

import { Unreachable } from "@myoxus/env/constant";

/**
 * A reference-counted handle for an object stored in an {@link ObjectPool}.
 *
 * Implements `Disposable` so that it can be used with `using` declarations.
 */
export interface RcRef<T> extends Disposable {
  /** The pooled object. */
  obj: T;
  /** Releases this reference.  When all refs are released the object may be GC'd. */
  release: () => void;
}

/**
 * A reference-counted pool of objects keyed by an arbitrary `Key` type.
 *
 * Objects are created externally and inserted with {@link put}.  Multiple
 * callers can hold concurrent references via {@link get}; the object is only
 * deleted when all references have been released AND either `onDangling` is
 * absent or returns `true`.
 *
 * @template Key - The map key type (e.g. string, number, or a custom object).
 * @template T   - The pooled object type.
 */
export class ObjectPool<Key, T> {
  /** Internal map of all pooled objects and their reference counts. */
  objects = new Map<Key, { obj: T; rc: number }>();
  /** Handle for the pending GC timer; `null` when no GC is pending. */
  timeoutToGc: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param options.onDelete   - Called just before an object is removed from
   *   the pool so that the caller can perform teardown (e.g. `doc.destroy()`).
   * @param options.onDangling - Called when an object's ref count reaches 0.
   *   Return `true` to allow deletion; return `false` to keep the object alive
   *   (useful for soft caches that want to delay teardown).
   */
  constructor(
    private readonly options: {
      onDelete?: (obj: T) => void;
      onDangling?: (obj: T) => boolean;
    } = {},
  ) {}

  /**
   * Returns an {@link RcRef} for an existing pooled object, incrementing its
   * reference count, or `null` if no object is pooled for `key`.
   *
   * @param key - The pool key to look up.
   */
  get(key: Key): RcRef<T> | null {
    const exist = this.objects.get(key);
    if (exist) {
      exist.rc++;
      let released = false;
      const release = () => {
        // avoid double release
        if (released) {
          return;
        }
        released = true;
        exist.rc--;
        this.requestGc();
      };
      return {
        obj: exist.obj,
        release,
        [Symbol.dispose]: release,
      };
    }
    return null;
  }

  /**
   * Adds `obj` to the pool under `key` and returns an initial {@link RcRef}
   * (rc = 1).
   *
   * @param key - The key to store the object under.
   * @param obj - The object to pool.
   * @throws {Unreachable} if the object cannot be retrieved immediately after
   *   insertion (should never happen).
   */
  put(key: Key, obj: T) {
    const ref = { obj, rc: 0 };
    this.objects.set(key, ref);

    const r = this.get(key);
    if (!r) {
      throw new Unreachable();
    }

    return r;
  }

  /**
   * Schedules a GC pass. Any existing pending GC is cancelled and rescheduled to
   * debounce rapid ref-count changes. A one-shot timeout is intentional: some
   * pools can keep objects dangling while sync/storage is still active, and a
   * fixed interval in always-mounted Web UI chrome can monopolise the main
   * thread in large workspaces.
   */
  private requestGc(delayMs = 1000) {
    if (this.timeoutToGc) {
      clearTimeout(this.timeoutToGc);
    }

    this.timeoutToGc = setTimeout(() => {
      this.timeoutToGc = null;
      this.gc();
    }, delayMs);
  }

  /**
   * Removes all objects with rc === 0 (subject to `onDangling`).
   * Stops the GC timer when all remaining objects have active references.
   */
  private gc() {
    let hasDeferredDangling = false;
    for (const [key, { obj, rc }] of new Map(
      this
        .objects /* clone the map, because the origin will be modified during iteration */,
    )) {
      if (rc !== 0) continue;
      if (!this.options.onDangling || this.options.onDangling(obj)) {
        this.options.onDelete?.(obj);

        this.objects.delete(key);
      } else {
        hasDeferredDangling = true;
      }
    }

    if (hasDeferredDangling) this.requestGc(5000);
  }

  /**
   * Removes all objects from the pool, calling `onDelete` for each.
   * Useful for full teardown when the pool owner is disposed.
   */
  clear() {
    for (const { obj } of this.objects.values()) {
      this.options.onDelete?.(obj);
    }

    this.objects.clear();
  }
}
