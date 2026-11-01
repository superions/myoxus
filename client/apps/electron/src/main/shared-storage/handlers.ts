import type {
  SharedStorageChanges,
  SharedStorageValue,
} from "@myoxus/desktop-api-contract";
import { Subject } from "rxjs";
import { isEqual } from "lodash-es";

import type { MainHandlerImplementations } from "../type";
import { globalCacheStorage, globalStateStorage } from "./storage";

// Subjects used by shared-storage/events.ts to broadcast updates to all renderer processes
export const globalStateUpdates$ = new Subject<SharedStorageChanges>();
export const globalCacheUpdates$ = new Subject<SharedStorageChanges>();

// Revision maps; main generates the next value each time
const globalStateRevisions = new Map<string, number>();
const globalCacheRevisions = new Map<string, number>();

function nextRev(revisions: Map<string, number>, key: string) {
  const r = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, r);
  return r;
}

let stateWrite = Promise.resolve();

/** A rejected flush must not make a retained creation key disappear from a
 * subsequent Main snapshot. Serialize acknowledged mutations and restore only
 * their unchanged keys, preserving unrelated direct Main-process updates.
 * The JSON owner rejects before its atomic rename; no renderer ACK is emitted. */
function confirmStateMutation(mutate: () => void, publish: () => void) {
  const operation = stateWrite.then(async () => {
    const before = globalStateStorage.all();
    let proposed: typeof before | undefined;
    try {
      mutate();
      proposed = globalStateStorage.all();
      await globalStateStorage.flush();
    } catch (error) {
      const after = proposed ?? globalStateStorage.all();
      const current = globalStateStorage.all();
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        const unchanged =
          Object.hasOwn(current, key) === Object.hasOwn(after, key) &&
          isEqual(current[key], after[key]);
        const changed =
          Object.hasOwn(before, key) !== Object.hasOwn(after, key) ||
          !isEqual(before[key], after[key]);
        if (changed && unchanged) {
          if (Object.hasOwn(before, key))
            globalStateStorage.set(key, before[key]);
          else globalStateStorage.del(key);
        }
      }
      throw error;
    }
    publish();
  });
  // Each caller receives its rejection; the queue remains usable for recovery.
  stateWrite = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export const sharedStorageHandlers = {
  getAllGlobalState: async () => {
    await stateWrite;
    return globalStateStorage.all();
  },
  getAllGlobalCache: async () => {
    return globalCacheStorage.all();
  },

  setGlobalState: async (
    _e,
    key: string,
    value: SharedStorageValue,
    sourceId?: string,
  ) => {
    await confirmStateMutation(
      () => globalStateStorage.set(key, value),
      () => {
        const rev = nextRev(globalStateRevisions, key);
        globalStateUpdates$.next({ [key]: { v: value, r: rev, s: sourceId } });
      },
    );
  },
  delGlobalState: async (_e, key: string, sourceId?: string) => {
    await confirmStateMutation(
      () => globalStateStorage.del(key),
      () => {
        const rev = nextRev(globalStateRevisions, key);
        globalStateUpdates$.next({
          [key]: { v: undefined, r: rev, s: sourceId },
        });
      },
    );
  },
  clearGlobalState: async (_e, sourceId?: string) => {
    await confirmStateMutation(
      () => globalStateStorage.clear(),
      () => {
        globalStateRevisions.clear();
        globalStateUpdates$.next({ "*": { v: undefined, r: 0, s: sourceId } });
      },
    );
  },

  setGlobalCache: async (
    _e,
    key: string,
    value: SharedStorageValue,
    sourceId?: string,
  ) => {
    const rev = nextRev(globalCacheRevisions, key);
    globalCacheStorage.set(key, value);
    await globalCacheStorage.flush();
    globalCacheUpdates$.next({ [key]: { v: value, r: rev, s: sourceId } });
  },
  delGlobalCache: async (_e, key: string, sourceId?: string) => {
    const rev = nextRev(globalCacheRevisions, key);
    globalCacheStorage.del(key);
    await globalCacheStorage.flush();
    globalCacheUpdates$.next({ [key]: { v: undefined, r: rev, s: sourceId } });
  },
  clearGlobalCache: async (_e, sourceId?: string) => {
    globalCacheRevisions.clear();
    globalCacheStorage.clear();
    await globalCacheStorage.flush();
    globalCacheUpdates$.next({ "*": { v: undefined, r: 0, s: sourceId } });
  },
} satisfies MainHandlerImplementations["sharedStorage"];
