import type { StoreInitOptions } from "../../worker/ops";
import {
  type RegisteredCloudDatabase,
  updateAppliedClientUpdateState,
} from "./web-client-update-state";

const CLOUD_INDEXED_DB_STORAGES = {
  blob: "IndexedDBBlobStorage",
  blobSync: "IndexedDBBlobSyncStorage",
  doc: "IndexedDBDocStorage",
  docSync: "IndexedDBDocSyncStorage",
  indexer: "IndexedDBIndexerStorage",
  indexerSync: "IndexedDBIndexerSyncStorage",
} as const;

type IndexedDbOptions = {
  flavour: string;
  type: string;
  id: string;
};

export interface CloudCacheInspection {
  existingDatabases: string[];
  pendingBlobs: number;
  pendingDocuments: number;
}

function isIndexedDbOptions(value: unknown): value is IndexedDbOptions {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IndexedDbOptions>;
  return (
    typeof candidate.flavour === "string" &&
    candidate.type === "workspace" &&
    typeof candidate.id === "string"
  );
}

/** Classifies only the six canonical Browser Web Cloud storage bindings. */
export function classifyCloudWorkspaceDatabase(
  options: StoreInitOptions,
): RegisteredCloudDatabase | null {
  let canonical: IndexedDbOptions | null = null;
  for (const [type, identifier] of Object.entries(CLOUD_INDEXED_DB_STORAGES)) {
    const storage = options.local[type as keyof typeof options.local];
    if (storage?.name !== identifier || !isIndexedDbOptions(storage.opts)) {
      return null;
    }
    canonical ??= storage.opts;
    if (
      storage.opts.flavour !== canonical.flavour ||
      storage.opts.type !== canonical.type ||
      storage.opts.id !== canonical.id
    ) {
      return null;
    }
  }

  if (!canonical) return null;
  const peerId = `cloud:${canonical.flavour}`;
  if (!Object.hasOwn(options.remotes, peerId)) return null;
  return {
    name: `${canonical.flavour}:workspace:${canonical.id}`,
    peerIds: [peerId],
  };
}

export function cloudWorkspaceDatabaseRegistration(
  flavour: string,
  workspaceId: string,
): RegisteredCloudDatabase {
  return {
    name: `${flavour}:workspace:${workspaceId}`,
    peerIds: [`cloud:${flavour}`],
  };
}

/** Merges exact names discovered from the authoritative workspace list. */
export async function registerCloudWorkspaceDatabases(
  endpoint: string,
  databases: RegisteredCloudDatabase[],
): Promise<void> {
  await updateAppliedClientUpdateState(endpoint, (current) => {
    const merged = new Map(
      current.registeredCloudDatabases.map((database) => [
        database.name,
        database,
      ]),
    );
    for (const database of databases) {
      merged.set(database.name, {
        name: database.name,
        peerIds: [...new Set(database.peerIds)].sort(),
      });
    }
    return {
      ...current,
      cloudDatabaseRegistryInitialized: true,
      registeredCloudDatabases: [...merged.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function existingDatabaseNames(): Promise<Set<string>> {
  const databases = await indexedDB.databases();
  return new Set(
    databases.flatMap((database) => (database.name ? [database.name] : [])),
  );
}

async function openExistingDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error(`Registered Cloud database disappeared: ${name}`));
    };
    request.onerror = () =>
      reject(request.error ?? new Error(`Failed to open ${name}`));
    request.onsuccess = () => resolve(request.result);
  });
}

async function inspectDatabase(
  registration: RegisteredCloudDatabase,
): Promise<{ pendingBlobs: number; pendingDocuments: number }> {
  const db = await openExistingDatabase(registration.name);
  try {
    for (const store of ["blobs", "blobSync", "clocks", "peerClocks"]) {
      if (!db.objectStoreNames.contains(store)) {
        throw new Error(
          `Registered Cloud database ${registration.name} lacks ${store}`,
        );
      }
    }

    const transaction = db.transaction(
      ["blobs", "blobSync", "clocks", "peerClocks"],
      "readonly",
    );
    const [blobs, blobSync, clocks, peerClocks] = await Promise.all([
      requestResult<Array<{ key: string; deletedAt: Date | null }>>(
        transaction.objectStore("blobs").getAll(),
      ),
      requestResult<
        Array<{ peer: string; key: string; uploadedAt: Date | null }>
      >(transaction.objectStore("blobSync").getAll()),
      requestResult<Array<{ docId: string; timestamp: Date }>>(
        transaction.objectStore("clocks").getAll(),
      ),
      requestResult<Array<{ peer: string; docId: string; pushedClock: Date }>>(
        transaction.objectStore("peerClocks").getAll(),
      ),
    ]);

    const pendingDocuments = clocks.filter((clock) =>
      registration.peerIds.some((peer) => {
        const remote = peerClocks.find(
          (candidate) =>
            candidate.peer === peer && candidate.docId === clock.docId,
        );
        return (
          !remote ||
          new Date(remote.pushedClock).getTime() <
            new Date(clock.timestamp).getTime()
        );
      }),
    ).length;
    const pendingBlobs = blobs.filter(
      (blob) =>
        blob.deletedAt === null &&
        registration.peerIds.some((peer) => {
          const remote = blobSync.find(
            (candidate) =>
              candidate.peer === peer && candidate.key === blob.key,
          );
          return !remote?.uploadedAt;
        }),
    ).length;

    return { pendingBlobs, pendingDocuments };
  } finally {
    db.close();
  }
}

/**
 * Inspects exact registered names. `indexedDB.databases()` is used only as an
 * existence check and never as a prefix- or flavour-based delete selector.
 */
export async function inspectRegisteredCloudDatabases(
  registrations: RegisteredCloudDatabase[],
): Promise<CloudCacheInspection> {
  const existing = await existingDatabaseNames();
  const result: CloudCacheInspection = {
    existingDatabases: [],
    pendingBlobs: 0,
    pendingDocuments: 0,
  };
  for (const registration of registrations) {
    if (!existing.has(registration.name)) continue;
    const inspection = await inspectDatabase(registration);
    result.existingDatabases.push(registration.name);
    result.pendingBlobs += inspection.pendingBlobs;
    result.pendingDocuments += inspection.pendingDocuments;
  }
  return result;
}

export async function deleteRegisteredCloudDatabases(
  names: string[],
): Promise<void> {
  for (const name of names) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error(`Failed to delete ${name}`));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`Cloud database deletion is blocked: ${name}`));
      };
    });
  }
}
