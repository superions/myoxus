import path from "node:path";

import type { SharedStorageSnapshot } from "@myoxus/desktop-api-contract";
import type { Memento } from "@myoxus/infra";
import { app } from "electron";
import { defer, type Observable } from "rxjs";

import { PersistentJSONFileStorage } from "./json-file";

export interface DesktopStateStorage extends Memento {
  all(): SharedStorageSnapshot;
  watchAll(): Observable<Record<string, unknown>>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

function lazyStorage(filename: string): DesktopStateStorage {
  let storage: PersistentJSONFileStorage | undefined;
  const current = () =>
    (storage ??= new PersistentJSONFileStorage(
      path.join(app.getPath("userData"), filename),
      filename,
    ));

  return {
    get: <T>(key: string) => current().get<T>(key),
    watch: <T>(key: string) => defer(() => current().watch<T>(key)),
    set: <T>(key: string, value: T | undefined) => current().set(key, value),
    del: (key: string) => current().del(key),
    clear: () => current().clear(),
    keys: () => current().keys(),
    all: () => current().all(),
    watchAll: () => defer(() => current().watchAll()),
    flush: () => current().flush(),
    dispose: () => current().dispose(),
  };
}

// Path resolution is deliberately lazy: index.ts may override Electron's
// userData directory before the first state access.
export const globalStateStorage = lazyStorage("global-state.json");
export const globalCacheStorage = lazyStorage("global-cache.json");
