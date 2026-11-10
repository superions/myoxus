import type {
  DesktopServerRegistryMutation,
  SharedStorageChanges,
  SharedStorageSnapshot,
  SharedStorageValue,
} from "@myoxus/desktop-api-contract";
import type {
  SharedStorage,
  SharedStorageArea,
} from "@myoxus/desktop-api-contract/bridge";
import { MemoryMemento } from "@myoxus/infra/storage";
import { ipcRenderer } from "electron";

import { MYOXUS_API_CHANNEL_NAME } from "../shared/type";
import { events } from "./electron-api";

// Unique id for this renderer instance, used to ignore self-originated broadcasts
const CLIENT_ID: string = Math.random().toString(36).slice(2);

function invokeWithCatch(key: string, ...args: SharedStorageValue[]) {
  ipcRenderer.invoke(MYOXUS_API_CHANNEL_NAME, key, ...args).catch((err) => {
    console.error(`Failed to invoke ${key}`, err);
  });
}

function createSharedStorageApi(
  init: SharedStorageSnapshot,
  event: "onGlobalStateChanged" | "onGlobalCacheChanged",
  api: {
    del: string;
    clear: string;
    set: string;
  },
): {
  area: SharedStorageArea;
  applyUpdates: (updates: SharedStorageChanges) => void;
} {
  const memory = new MemoryMemento();
  const revisions = new Map<string, number>();
  const updateQueue: SharedStorageChanges[] = [];
  let loaded = false;

  const applyUpdates = (updates: SharedStorageChanges) => {
    for (const [key, raw] of Object.entries(updates)) {
      // '*' means "reset everything" coming from a clear operation
      if (key === "*") {
        memory.clear();
        revisions.clear();
        continue;
      }

      const { v: value, s: source, r: rev } = raw;

      // Ignore our own broadcasts
      if (source && source === CLIENT_ID) {
        continue;
      }

      const current = revisions.get(key) ?? -1;
      if (rev <= current) {
        continue;
      }
      revisions.set(key, rev);

      if (value === undefined) {
        memory.del(key);
      } else {
        memory.set(key, value);
      }
    }
  };

  // Listening on ipcRenderer alone does not subscribe Main's routed channel.
  // Reuse the event bridge so every frame receives shared-cache invalidations.
  events.sharedStorage[event]((changes) => {
    if (loaded) applyUpdates(changes);
    else updateQueue.push(changes);
  });

  const initPromise = (async () => {
    try {
      memory.setAll(init);
      const latest: unknown = await ipcRenderer.invoke(
        MYOXUS_API_CHANNEL_NAME,
        event === "onGlobalStateChanged"
          ? "sharedStorage:getAllGlobalState"
          : "sharedStorage:getAllGlobalCache",
      );
      if (latest && typeof latest === "object") {
        memory.setAll(latest as SharedStorageSnapshot);
      }
    } catch (err) {
      console.error("Failed to load initial shared storage", err);
    } finally {
      loaded = true;
      while (updateQueue.length) {
        const updates = updateQueue.shift();
        if (updates) {
          applyUpdates(updates);
        }
      }
    }
  })();

  return {
    applyUpdates,
    area: {
      ready: initPromise,
      del(key: string) {
        memory.del(key);
        invokeWithCatch(`sharedStorage:${api.del}`, key, CLIENT_ID);
      },
      clear() {
        memory.clear();
        revisions.clear();
        invokeWithCatch(`sharedStorage:${api.clear}`, CLIENT_ID);
      },
      get<Value extends SharedStorageValue>(key: string): Value | undefined {
        return memory.get<Value>(key);
      },
      keys() {
        return memory.keys();
      },
      set<Value extends SharedStorageValue>(key: string, value: Value) {
        memory.set(key, value);
        invokeWithCatch(`sharedStorage:${api.set}`, key, value, CLIENT_ID);
      },
      watch<Value extends SharedStorageValue>(
        key: string,
        cb: (value: Value | undefined) => void,
      ): () => void {
        const subscription = memory.watch<Value>(key).subscribe(cb);
        return () => subscription.unsubscribe();
      },
    },
  };
}

const stateStorage = createSharedStorageApi({}, "onGlobalStateChanged", {
  clear: "clearGlobalState",
  del: "delGlobalState",
  set: "setGlobalState",
});

const cacheStorage = createSharedStorageApi({}, "onGlobalCacheChanged", {
  clear: "clearGlobalCache",
  del: "delGlobalCache",
  set: "setGlobalCache",
});

export const globalState = stateStorage.area;
export const globalCache = cacheStorage.area;

/** Main's broadcast can arrive after its IPC reply. Publish the confirmed
 * revisions before resolving, without overwriting newer cross-window events. */
export async function mutateServerRegistry(
  mutation: DesktopServerRegistryMutation,
): Promise<SharedStorageChanges> {
  await globalState.ready;
  const changes: SharedStorageChanges = await ipcRenderer.invoke(
    MYOXUS_API_CHANNEL_NAME,
    "sharedStorage:mutateServerRegistry",
    mutation,
  );
  stateStorage.applyUpdates(changes);
  return changes;
}

export const sharedStorage = {
  globalState,
  globalCache,
} satisfies SharedStorage;
