import type { AsyncMemento, Memento } from "@myoxus/infra";
import { type IDBPDatabase, openDB } from "idb";
import { Observable, Subject } from "rxjs";

import type {
  CacheStorage,
  GlobalCache,
  GlobalSessionState,
  GlobalState,
} from "../providers/global";

export class StorageMemento implements Memento {
  // Same-tab updates are synchronous; BroadcastChannel handles other tabs.
  private readonly changes = new Subject<{ key: string; value: unknown }>();
  // channel is used for cross-tab event
  private readonly channel = new BroadcastChannel(this.prefix);
  constructor(
    private readonly storage: Storage,
    private readonly prefix: string,
  ) {}

  keys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key && key.startsWith(this.prefix)) {
        keys.push(key.slice(this.prefix.length));
      }
    }
    return keys;
  }

  get<T>(key: string): T | undefined {
    const json = this.storage.getItem(this.prefix + key);
    return json ? JSON.parse(json) : undefined;
  }
  watch<T>(key: string): Observable<T | undefined> {
    return new Observable<T | undefined>((subscriber) => {
      const json = this.storage.getItem(this.prefix + key);
      const first = json ? JSON.parse(json) : undefined;
      subscriber.next(first);

      const eventEmitterCb = (value: T) => {
        subscriber.next(value);
      };
      const subscription = this.changes.subscribe((change) => {
        if (change.key === key) eventEmitterCb(change.value as T);
      });

      const channelCb = (event: MessageEvent) => {
        if (event.data.key === key) {
          subscriber.next(event.data.value);
        }
      };
      this.channel.addEventListener("message", channelCb);
      return () => {
        subscription.unsubscribe();
        this.channel.removeEventListener("message", channelCb);
      };
    });
  }
  set<T>(key: string, value: T): void {
    this.storage.setItem(this.prefix + key, JSON.stringify(value));
    this.changes.next({ key, value });
    this.channel.postMessage({ key, value });
  }

  del(key: string): void {
    this.storage.removeItem(this.prefix + key);
  }

  clear(): void {
    for (const key of this.keys()) {
      this.del(key);
    }
  }
}

export class LocalStorageGlobalCache
  extends StorageMemento
  implements GlobalCache
{
  constructor() {
    super(localStorage, "global-cache:");
  }
}

export class LocalStorageGlobalState
  extends StorageMemento
  implements GlobalState
{
  constructor() {
    super(localStorage, "global-state:");
  }
}

export class SessionStorageGlobalSessionState
  extends StorageMemento
  implements GlobalSessionState
{
  constructor() {
    super(sessionStorage, "global-session-state:");
  }
}

export class AsyncStorageMemento implements AsyncMemento {
  // Same-tab updates are synchronous; BroadcastChannel handles other tabs.
  private readonly changes = new Subject<{ key: string; value: unknown }>();
  // channel is used for cross-tab event
  private readonly channel = new BroadcastChannel(this.dbName);
  constructor(
    private readonly dbName: string,
    private readonly table: string,
  ) {}

  private _db: IDBPDatabase<any> | null = null;

  private async getDB() {
    const { dbName, table } = this;
    if (!this._db) {
      this._db = await openDB(dbName, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(table)) {
            db.createObjectStore(table, { keyPath: "key" });
          }
        },
      });
    }
    return this._db;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.getDB();
    const tx = db.transaction(this.table, "readonly");
    const store = tx.objectStore(this.table);
    const result = await store.get(key);
    return result?.value;
  }

  watch<T>(key: string): Observable<T | undefined> {
    return new Observable<T | undefined>((subscriber) => {
      // A later update supersedes the pending initial read. Otherwise its stale
      // completion can overwrite a value already delivered by a local/channel event.
      let updated = false;
      this.get<T>(key).then(
        (value) => {
          if (!updated) subscriber.next(value);
        },
        (error) => {
          console.error("Error getting initial value:", error);
          if (!updated) subscriber.next(undefined);
        },
      );

      // Listen for same tab events
      const eventEmitterCb = (value: T) => {
        updated = true;
        subscriber.next(value);
      };
      const subscription = this.changes.subscribe((change) => {
        if (change.key === key) eventEmitterCb(change.value as T);
      });

      // Listen for cross-tab events
      const channelCb = (event: MessageEvent) => {
        if (event.data.key === key) {
          updated = true;
          subscriber.next(event.data.value);
        }
      };
      this.channel.addEventListener("message", channelCb);

      return () => {
        subscription.unsubscribe();
        this.channel.removeEventListener("message", channelCb);
      };
    });
  }

  async set<T>(key: string, value: T | undefined): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(this.table, "readwrite");
    const store = tx.objectStore(this.table);

    if (value === undefined) {
      await store.delete(key);
    } else {
      await store.put({ key, value });
    }

    // Emit events
    this.changes.next({ key, value });
    this.channel.postMessage({ key, value });
  }

  async del(key: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(this.table, "readwrite");
    const store = tx.objectStore(this.table);
    await store.delete(key);

    // Emit events
    this.changes.next({ key, value: undefined });
    this.channel.postMessage({ key, value: undefined });
  }

  async clear(): Promise<void> {
    const keys = await this.keys();
    const db = await this.getDB();
    const tx = db.transaction(this.table, "readwrite");
    const store = tx.objectStore(this.table);
    await store.clear();

    // Notify observers about each deleted key
    for (const key of keys) {
      this.changes.next({ key, value: undefined });
      this.channel.postMessage({ key, value: undefined });
    }
  }

  async keys(): Promise<string[]> {
    const db = await this.getDB();
    const tx = db.transaction(this.table, "readonly");
    const store = tx.objectStore(this.table);
    const allObjects = await store.getAll();
    return allObjects.map((obj) => obj.key);
  }
}

export class IDBGlobalState
  extends AsyncStorageMemento
  implements CacheStorage
{
  constructor() {
    super("global-storage", "global-state");
  }
}
