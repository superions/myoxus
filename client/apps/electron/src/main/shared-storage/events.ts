import type { SharedStorageChanges } from "@myoxus/desktop-api-contract";

import type { MainEventImplementations } from "../type";
import { globalCacheUpdates$, globalStateUpdates$ } from "./handlers";

export const sharedStorageEvents = {
  onGlobalStateChanged: (fn: (state: SharedStorageChanges) => void) => {
    const subscription = globalStateUpdates$.subscribe(fn);
    return () => subscription.unsubscribe();
  },
  onGlobalCacheChanged: (fn: (state: SharedStorageChanges) => void) => {
    const subscription = globalCacheUpdates$.subscribe(fn);
    return () => subscription.unsubscribe();
  },
} satisfies MainEventImplementations["sharedStorage"];
