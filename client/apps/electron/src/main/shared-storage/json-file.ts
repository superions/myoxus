import fs from "node:fs";
import path from "node:path";

import type {
  SharedStoragePersistedValue,
  SharedStorageSnapshot,
  SharedStorageValue,
} from "@myoxus/desktop-api-contract";
import type { Memento } from "@myoxus/infra";
import { Observable } from "rxjs";

import { logger } from "../logger";

type StorageRecord = Record<string, SharedStoragePersistedValue>;
type StorageChanges = Record<string, SharedStorageValue>;

function isPersistedValue(
  value: unknown,
): value is SharedStoragePersistedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPersistedValue);
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Object.values(value).every(isPersistedValue);
}

function normalizePersistedValue(value: unknown): SharedStoragePersistedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) {
        throw new TypeError("desktop state arrays cannot contain undefined");
      }
      return normalizePersistedValue(item);
    });
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const normalized: Record<string, SharedStoragePersistedValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) normalized[key] = normalizePersistedValue(item);
    }
    return normalized;
  }
  throw new TypeError("desktop state values must be JSON-persistable");
}

function isStorageRecord(value: unknown): value is StorageRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPersistedValue)
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

/** Loading failure never grants permission to replace the deployed state. */
export class DesktopStateLoadError extends Error {
  override readonly name = "DesktopStateLoadError";

  constructor(
    readonly storage: string,
    readonly code: string,
  ) {
    super(`Failed to load ${storage} (${code})`);
  }
}

export class DesktopStatePersistenceError extends Error {
  override readonly name = "DesktopStatePersistenceError";

  constructor(
    readonly storage: string,
    readonly code: string,
  ) {
    super(`Failed to persist ${storage} (${code})`);
  }
}

export class PersistentJSONFileStorage implements Memento {
  private data: StorageRecord = {};
  private readonly subscriptions = new Map<
    string,
    Set<(value: unknown) => void>
  >();
  private readonly allSubscriptions = new Set<
    (value: StorageChanges) => void
  >();
  private dirtyRevision = 0;
  private persistedRevision = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private writeChain = Promise.resolve();
  private disposed = false;

  constructor(
    readonly filepath: string,
    private readonly label = path.basename(filepath),
  ) {
    this.load();
  }

  private load() {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filepath, "utf8"),
      );
      if (!isStorageRecord(parsed)) {
        throw new TypeError("storage root must be a JSON object");
      }
      this.data = parsed;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new DesktopStateLoadError(
          this.label,
          errorCode(error) ??
            (error instanceof SyntaxError ? "INVALID_JSON" : "INVALID_ROOT"),
        );
      }
      this.data = {};
    }
  }

  private notify(key: string, value: SharedStorageValue) {
    for (const subscription of this.subscriptions.get(key) ?? []) {
      subscription(value);
    }
    for (const subscription of this.allSubscriptions) {
      subscription({ [key]: value });
    }
  }

  private markDirty() {
    if (this.disposed) {
      throw new Error(`Cannot mutate disposed storage ${this.label}`);
    }
    this.dirtyRevision += 1;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush().catch((error) => {
        logger.error("failed to persist desktop state", {
          storage: this.label,
          code: errorCode(error),
          error,
        });
      });
    }, 1000);
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  all(): SharedStorageSnapshot {
    return { ...this.data };
  }

  watch<T>(key: string): Observable<T | undefined> {
    return new Observable<T | undefined>((subscriber) => {
      const subscriptions = this.subscriptions.get(key) ?? new Set();
      this.subscriptions.set(key, subscriptions);
      const subscription = (value: unknown) =>
        subscriber.next(value as T | undefined);
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    });
  }

  watchAll(): Observable<StorageChanges> {
    return new Observable<StorageChanges>((subscriber) => {
      const subscription = (value: StorageChanges) => subscriber.next(value);
      this.allSubscriptions.add(subscription);
      return () => this.allSubscriptions.delete(subscription);
    });
  }

  set<T>(key: string, value: T | undefined): void {
    if (value === undefined) {
      this.del(key);
      return;
    }
    this.data[key] = normalizePersistedValue(value);
    this.notify(key, this.data[key]);
    this.markDirty();
  }

  del(key: string): void {
    if (!(key in this.data)) return;
    delete this.data[key];
    this.notify(key, undefined);
    this.markDirty();
  }

  clear(): void {
    const keys = Object.keys(this.data);
    if (keys.length === 0) return;
    this.data = {};
    for (const key of keys) {
      for (const subscription of this.subscriptions.get(key) ?? []) {
        subscription(undefined);
      }
    }
    const changes: StorageChanges = Object.fromEntries(
      keys.map((key) => [key, undefined]),
    );
    for (const subscription of this.allSubscriptions) subscription(changes);
    this.markDirty();
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const requestedRevision = this.dirtyRevision;
    if (requestedRevision <= this.persistedRevision) return this.writeChain;

    const write = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        if (requestedRevision <= this.persistedRevision) return;

        const serialized = JSON.stringify(this.data, null, 2);
        const revision = this.dirtyRevision;
        const directory = path.dirname(this.filepath);
        const temporary = path.join(
          directory,
          `.${path.basename(this.filepath)}.${process.pid}.${revision}.tmp`,
        );

        let handle: fs.promises.FileHandle | undefined;
        try {
          await fs.promises.mkdir(directory, { recursive: true });
          handle = await fs.promises.open(temporary, "wx", 0o600);
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
          await handle.close();
          handle = undefined;
          await fs.promises.rename(temporary, this.filepath);
          this.persistedRevision = revision;
        } catch (error) {
          throw new DesktopStatePersistenceError(
            this.label,
            errorCode(error) ?? "UNKNOWN",
          );
        } finally {
          await handle?.close().catch(() => undefined);
          await fs.promises
            .rm(temporary, { force: true })
            .catch(() => undefined);
        }
      });
    this.writeChain = write;
    return write;
  }

  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    this.subscriptions.clear();
    this.allSubscriptions.clear();
  }
}
