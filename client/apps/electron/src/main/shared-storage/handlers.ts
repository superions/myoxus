import type {
  DesktopServerRegistryMutation,
  SharedStorageChanges,
  SharedStorageValue,
} from "@myoxus/desktop-api-contract";
import { Subject } from "rxjs";
import { isEqual } from "lodash-es";

import type { MainHandlerImplementations } from "../type";
import {
  registeredDesktopServers,
  validateDesktopServerRegistration,
} from "../server-routing";
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
  mutateServerRegistry: async (_e, mutation: DesktopServerRegistryMutation) => {
    if (!mutation || (mutation.type !== "add" && mutation.type !== "remove")) {
      throw new TypeError("Invalid server registry mutation");
    }
    const server =
      mutation.type === "add"
        ? validateDesktopServerRegistration(mutation.server, mutation.config)
        : undefined;
    if (
      mutation.type === "remove" &&
      (typeof mutation.id !== "string" || !/^[\w-]+$/.test(mutation.id))
    ) {
      throw new TypeError("Invalid server identity");
    }
    const changed = new Set<string>();
    let confirmation: SharedStorageChanges = {};
    await confirmStateMutation(
      () => {
        const list = globalStateStorage.get<unknown>("serverList") ?? [];
        if (!Array.isArray(list))
          throw new TypeError("Invalid persisted server registry");
        if (mutation.type === "add" && server) {
          if (
            list.some(
              (record) =>
                record &&
                typeof record === "object" &&
                (record.id === server.id || record.baseUrl === server.baseUrl),
            )
          ) {
            throw new Error(
              "A server with this identity or origin already exists",
            );
          }
          // One Main-owned transaction makes config, list and selection durable
          // before any frame can react and issue a scoped proxy request.
          const key = `serverConfig:${server.id}`;
          globalStateStorage.set(key, mutation.config);
          globalStateStorage.set("serverList", [...list, server]);
          globalStateStorage.set("selectedServerId", server.id);
          changed.add(key);
          changed.add("serverList");
          changed.add("selectedServerId");
        } else if (mutation.type === "remove") {
          globalStateStorage.set(
            "serverList",
            list.filter(
              (record) =>
                !record ||
                typeof record !== "object" ||
                record.id !== mutation.id,
            ),
          );
          changed.add("serverList");
          if (globalStateStorage.get("selectedServerId") === mutation.id) {
            globalStateStorage.set(
              "selectedServerId",
              registeredDesktopServers()[0]?.id,
            );
            changed.add("selectedServerId");
          }
        }
      },
      () => {
        confirmation = Object.fromEntries(
          [...changed].map((key) => [
            key,
            {
              v: globalStateStorage.get<SharedStorageValue>(key),
              r: nextRev(globalStateRevisions, key),
            },
          ]),
        );
        globalStateUpdates$.next(confirmation);
      },
    );
    return confirmation;
  },
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
