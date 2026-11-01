import {
  deleteRegisteredCloudDatabases,
  inspectRegisteredCloudDatabases,
  readAppliedClientUpdateState,
} from "@myoxus/storage/cloud";
import type { ClientUpdateCacheResetReadiness } from "@myoxus/storage/worker/client";

export type ClientUpdateCacheResetSnapshot =
  | { status: "idle" }
  | {
      status: "waiting";
      pendingBlobs: number;
      pendingDocuments: number;
    }
  | { status: "deleting" }
  | { status: "failed" }
  | { status: "completed" };

interface ClientUpdateCacheResetAdapter {
  prepare(): Promise<ClientUpdateCacheResetReadiness>;
}

let snapshot: ClientUpdateCacheResetSnapshot = { status: "idle" };
const listeners = new Set<() => void>();
let adapter: ClientUpdateCacheResetAdapter | null = null;
let resolveAdapter: ((adapter: ClientUpdateCacheResetAdapter) => void) | null =
  null;
let retry: (() => void) | null = null;

const adapterReady = new Promise<ClientUpdateCacheResetAdapter>((resolve) => {
  resolveAdapter = resolve;
});

function setSnapshot(next: ClientUpdateCacheResetSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const clientUpdateCacheResetStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  retry() {
    retry?.();
  },
};

export function configureClientUpdateCacheResetAdapter(
  next: ClientUpdateCacheResetAdapter,
) {
  adapter = next;
  resolveAdapter?.(next);
  resolveAdapter = null;
}

function wait(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAdapter(signal: AbortSignal) {
  if (adapter) return Promise.resolve(adapter);
  return new Promise<ClientUpdateCacheResetAdapter>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void adapterReady.then((readyAdapter) => {
      signal.removeEventListener("abort", onAbort);
      resolve(readyAdapter);
    });
  });
}

function waitForRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      retry = null;
      reject(signal.reason);
    };
    retry = () => {
      retry = null;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Deletes only endpoint-registered Cloud working copies. The durable epoch
 * fence is owned by the completion coordinator and therefore survives every
 * failure or navigation before this function returns successfully.
 */
export async function resetRegisteredCloudCaches(
  endpoint: string,
  signal: AbortSignal,
): Promise<void> {
  const resetAdapter = await waitForAdapter(signal);

  while (!signal.aborted) {
    try {
      const state = await readAppliedClientUpdateState(endpoint);
      if (!state.cloudDatabaseRegistryInitialized) {
        setSnapshot({
          status: "waiting",
          pendingBlobs: 0,
          pendingDocuments: 0,
        });
        await wait(signal, 250);
        continue;
      }

      const inspection = await inspectRegisteredCloudDatabases(
        state.registeredCloudDatabases,
      );
      if (inspection.pendingBlobs > 0 || inspection.pendingDocuments > 0) {
        setSnapshot({
          status: "waiting",
          pendingBlobs: inspection.pendingBlobs,
          pendingDocuments: inspection.pendingDocuments,
        });
        await wait(signal, 1_000);
        continue;
      }

      const readiness = await resetAdapter.prepare();
      if (!readiness.ready) {
        setSnapshot({
          status: "waiting",
          pendingBlobs: readiness.pendingBlobs,
          pendingDocuments: readiness.pendingDocuments,
        });
        await wait(signal, 1_000);
        continue;
      }

      setSnapshot({ status: "deleting" });
      await deleteRegisteredCloudDatabases(inspection.existingDatabases);
      setSnapshot({ status: "completed" });
      return;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      setSnapshot({ status: "failed" });
      await waitForRetry(signal);
    }
  }

  throw signal.reason ?? new Error("Client update cache reset aborted");
}

export function resetClientUpdateCacheResetStore() {
  setSnapshot({ status: "idle" });
}
