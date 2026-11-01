import type { SharedStorageValue } from "@myoxus/desktop-api-contract";
import { Observable } from "rxjs";

import type { DesktopApiService } from "../../desktop-api";
import type { GlobalCache, GlobalState } from "../providers/global";

function toSharedStorageValue<Value>(value: Value): SharedStorageValue {
  try {
    return structuredClone(value) as SharedStorageValue;
  } catch (error) {
    throw new TypeError("Desktop global storage values must be cloneable", {
      cause: error,
    });
  }
}

export class ElectronGlobalState implements GlobalState {
  constructor(private readonly electronApi: DesktopApiService) {}

  get ready() {
    return this.electronApi.sharedStorage.globalState.ready;
  }

  keys(): string[] {
    return this.electronApi.sharedStorage.globalState.keys();
  }
  get<T>(key: string): T | undefined {
    return this.electronApi.sharedStorage.globalState.get(key) as T | undefined;
  }
  watch<T>(key: string) {
    return new Observable<T | undefined>((subscriber) => {
      const unsubscribe = this.electronApi.sharedStorage.globalState.watch(
        key,
        (i) => {
          subscriber.next(i as T | undefined);
        },
      );
      return () => unsubscribe();
    });
  }
  set<T>(key: string, value: T): void {
    this.electronApi.sharedStorage.globalState.set(
      key,
      toSharedStorageValue(value),
    );
  }
  async getConfirmed<T>(key: string): Promise<T | undefined> {
    const snapshot =
      await this.electronApi.handler.sharedStorage.getAllGlobalState();
    return snapshot[key] as T | undefined;
  }
  async setConfirmed<T>(key: string, value: T | undefined): Promise<void> {
    // Invoke the existing Main owner directly: preload's optimistic set catches
    // persistence failures and cannot authorize an API or filesystem write.
    if (value === undefined)
      await this.electronApi.handler.sharedStorage.delGlobalState(key);
    else
      await this.electronApi.handler.sharedStorage.setGlobalState(
        key,
        toSharedStorageValue(value),
      );
  }
  del(key: string): void {
    this.electronApi.sharedStorage.globalState.del(key);
  }
  clear(): void {
    this.electronApi.sharedStorage.globalState.clear();
  }
}

export class ElectronGlobalCache implements GlobalCache {
  constructor(private readonly electronApi: DesktopApiService) {}

  keys(): string[] {
    return this.electronApi.sharedStorage.globalCache.keys();
  }
  get<T>(key: string): T | undefined {
    return this.electronApi.sharedStorage.globalCache.get(key) as T | undefined;
  }
  watch<T>(key: string) {
    return new Observable<T | undefined>((subscriber) => {
      const unsubscribe = this.electronApi.sharedStorage.globalCache.watch(
        key,
        (i) => {
          subscriber.next(i as T | undefined);
        },
      );
      return () => unsubscribe();
    });
  }
  set<T>(key: string, value: T): void {
    this.electronApi.sharedStorage.globalCache.set(
      key,
      toSharedStorageValue(value),
    );
  }
  del(key: string): void {
    this.electronApi.sharedStorage.globalCache.del(key);
  }
  clear(): void {
    this.electronApi.sharedStorage.globalCache.clear();
  }
}
