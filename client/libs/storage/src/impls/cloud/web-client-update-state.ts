const WEB_CLIENT_STATE_DB = "myoxus-web-client-identity";
const LEGACY_WEB_CLIENT_ID_STORE = "endpoint-client-ids";
const WEB_CLIENT_UPDATE_STATE_STORE = "endpoint-update-state";
const WEB_CLIENT_STATE_DB_VERSION = 3;

export interface AppliedClientUpdateState {
  observedOperationId: string | null;
  appliedCompletionOperationId: string | null;
  appliedCacheEpoch: number;
  resetInProgressEpoch: number | null;
  cloudDatabaseRegistryInitialized: boolean;
  registeredCloudDatabases: RegisteredCloudDatabase[];
}

export interface RegisteredCloudDatabase {
  name: string;
  peerIds: string[];
}

type StoredClientUpdateState = Partial<AppliedClientUpdateState> & {
  endpoint: string;
};

const INITIAL_CLIENT_UPDATE_STATE: AppliedClientUpdateState = {
  observedOperationId: null,
  appliedCompletionOperationId: null,
  appliedCacheEpoch: 0,
  resetInProgressEpoch: null,
  cloudDatabaseRegistryInitialized: false,
  registeredCloudDatabases: [],
};

function updateStateFromStored(
  stored: StoredClientUpdateState | undefined,
): AppliedClientUpdateState {
  if (!stored) return { ...INITIAL_CLIENT_UPDATE_STATE };
  return {
    observedOperationId: stored.observedOperationId ?? null,
    appliedCompletionOperationId: stored.appliedCompletionOperationId ?? null,
    appliedCacheEpoch: stored.appliedCacheEpoch ?? 0,
    resetInProgressEpoch: stored.resetInProgressEpoch ?? null,
    cloudDatabaseRegistryInitialized:
      stored.cloudDatabaseRegistryInitialized ?? false,
    registeredCloudDatabases: stored.registeredCloudDatabases ?? [],
  };
}

/** Canonicalizes the server endpoint used by the update/cache recovery fence. */
export function normalizeClientUpdateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new TypeError("Socket endpoint must use HTTP(S) or WS(S)");
  }
  if (url.username || url.password) {
    throw new TypeError("Socket endpoint must not contain credentials");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

function openClientUpdateStateDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // The persisted database name remains stable so existing update fences can
    // be retained while the obsolete Browser profile-ID store is removed.
    const request = indexedDB.open(
      WEB_CLIENT_STATE_DB,
      WEB_CLIENT_STATE_DB_VERSION,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(LEGACY_WEB_CLIENT_ID_STORE)) {
        db.deleteObjectStore(LEGACY_WEB_CLIENT_ID_STORE);
      }
      if (!db.objectStoreNames.contains(WEB_CLIENT_UPDATE_STATE_STORE)) {
        db.createObjectStore(WEB_CLIENT_UPDATE_STATE_STORE, {
          keyPath: "endpoint",
        });
      }
    };
    request.onerror = () =>
      reject(
        request.error ??
          new Error("Failed to open web client update state database"),
      );
    request.onsuccess = () => resolve(request.result);
  });
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Web client update state transaction aborted"),
      );
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error("Web client update state transaction failed"),
      );
  });
}

/** Reads the single overwritten update-control record for one server endpoint. */
export async function readAppliedClientUpdateState(
  endpoint: string,
): Promise<AppliedClientUpdateState> {
  const normalizedEndpoint = normalizeClientUpdateEndpoint(endpoint);
  const db = await openClientUpdateStateDatabase();
  try {
    const transaction = db.transaction(
      WEB_CLIENT_UPDATE_STATE_STORE,
      "readonly",
    );
    const stored = await readRequest<StoredClientUpdateState | undefined>(
      transaction
        .objectStore(WEB_CLIENT_UPDATE_STATE_STORE)
        .get(normalizedEndpoint),
    );
    await transactionDone(transaction);
    return updateStateFromStored(stored);
  } finally {
    db.close();
  }
}

/** Atomically updates the endpoint-scoped update/cache recovery fence. */
export async function updateAppliedClientUpdateState(
  endpoint: string,
  update: (current: AppliedClientUpdateState) => AppliedClientUpdateState,
): Promise<AppliedClientUpdateState> {
  const normalizedEndpoint = normalizeClientUpdateEndpoint(endpoint);
  const db = await openClientUpdateStateDatabase();
  try {
    const transaction = db.transaction(
      WEB_CLIENT_UPDATE_STATE_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(WEB_CLIENT_UPDATE_STATE_STORE);
    const stored = await readRequest<StoredClientUpdateState | undefined>(
      store.get(normalizedEndpoint),
    );
    const next = update(updateStateFromStored(stored));
    store.put({ endpoint: normalizedEndpoint, ...next });
    await transactionDone(transaction);
    return next;
  } finally {
    db.close();
  }
}
