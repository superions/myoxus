// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, type Page } from "@playwright/test";

type AbandonedLease = { database: string; key: string; timestamp: number };

/** Acquire only an unused legacy root lease, then terminate its test-owned worker. */
export async function installAbandonedRootLock(
  page: Page,
): Promise<AbandonedLease> {
  return page.evaluate(async () => {
    const workspace = (window as Window & { currentWorkspace?: { id: string } })
      .currentWorkspace;
    if (!workspace) throw new Error("No workspace for lease crash probe");
    const database = `myoxus-cloud:workspace:${workspace.id}`;
    const key = `workspace:${workspace.id}:update:${workspace.id}`;
    const code = `self.onmessage = e => {
      const { database, key } = e.data;
      const open = indexedDB.open(database);
      open.onerror = () => self.postMessage({ error: "lease database open failed" });
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction("locks", "readwrite"), store = tx.objectStore("locks");
        tx.onabort = () => { db.close(); self.postMessage({ busy: true }); };
        const get = store.get(key);
        get.onsuccess = () => {
          if (get.result) { tx.abort(); return; }
          const timestamp = Date.now();
          store.put({ key, lock: new Date(timestamp) });
          tx.oncomplete = () => { db.close(); self.postMessage({ timestamp }); };
        };
      };
    };`;
    const url = URL.createObjectURL(
      new Blob([code], { type: "application/javascript" }),
    );
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const worker = new Worker(url);
        try {
          const result = await new Promise<{
            error?: string;
            timestamp?: number;
          }>((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data);
            worker.onerror = reject;
            worker.postMessage({ database, key });
          });
          if (result.error) throw new Error(result.error);
          if (result.timestamp !== undefined)
            return { database, key, timestamp: result.timestamp };
        } finally {
          worker.terminate();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Crash probe could not acquire an unused root lease");
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}

/** Delete only this probe's lease; never replace or clear another live owner. */
export async function removeAbandonedRootLock(
  page: Page,
  lease: AbandonedLease,
) {
  await page.evaluate(async ({ database, key, timestamp }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(database);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("locks", "readwrite"),
          store = tx.objectStore("locks");
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error ?? new Error("Lease cleanup aborted"));
        const get = store.get(key);
        get.onsuccess = () => {
          if (get.result?.lock.getTime() === timestamp) store.delete(key);
        };
      });
    } finally {
      db.close();
    }
  }, lease);
}

/** Native IDB must retain committed bytes and roll back a terminated writer. */
export async function proveTransactionRollbackOnTermination(page: Page) {
  const result = await page.evaluate(async () => {
    const workspace = (window as Window & { currentWorkspace?: { id: string } })
      .currentWorkspace;
    if (!workspace) throw new Error("No workspace for transaction crash probe");
    const database = `myoxus-cloud:workspace:${workspace.id}`;
    const docId = `transaction-crash-probe:${crypto.randomUUID()}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(database);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const transaction = (
      write: boolean,
      work: (store: IDBObjectStore) => void,
    ) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          "snapshots",
          write ? "readwrite" : "readonly",
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error ?? new Error("Crash probe transaction aborted"));
        work(tx.objectStore("snapshots"));
      });
    const code = `self.onmessage = e => {
      const { database, docId } = e.data, open = indexedDB.open(database);
      open.onerror = () => self.postMessage({ error: "transaction database open failed" });
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(["snapshots", "updates"], "readwrite"), store = tx.objectStore("snapshots");
        tx.oncomplete = () => self.postMessage({ committed: true });
        tx.onabort = () => self.postMessage({ error: "probe aborted before termination" });
        const put = store.put({ docId, bin: new Uint8Array([42]), createdAt: new Date(), updatedAt: new Date() });
        put.onsuccess = () => {
          const read = store.get(docId);
          read.onsuccess = () => {
            const keepAlive = () => { const request = store.get(docId); request.onsuccess = keepAlive; };
            keepAlive();
            self.postMessage({ readOwnWrite: read.result?.bin[0] === 42 });
          };
        };
      };
    };`;
    const url = URL.createObjectURL(
      new Blob([code], { type: "application/javascript" }),
    );
    const worker = new Worker(url);
    try {
      await transaction(true, (store) =>
        store.put({
          docId,
          bin: new Uint8Array([0, 0]),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      const state = await new Promise<{
        readOwnWrite?: boolean;
        error?: string;
      }>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = reject;
        worker.postMessage({ database, docId });
      });
      worker.terminate();
      if (state.error) throw new Error(state.error);
      let bytes: number[] | undefined;
      await transaction(false, (store) => {
        const read = store.get(docId);
        read.onsuccess = () => {
          bytes = Array.from(read.result.bin);
        };
      });
      return {
        readOwnWrite: state.readOwnWrite === true,
        committedBytes: bytes,
      };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
      try {
        await transaction(true, (store) => store.delete(docId));
      } finally {
        db.close();
      }
    }
  });
  expect(result).toEqual({ readOwnWrite: true, committedBytes: [0, 0] });
}
