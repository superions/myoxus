import { mkdir } from "node:fs/promises";
import path from "node:path";

import { DocStoragePool } from "@myoxus/local-store";
import { parseUniversalId } from "@myoxus/storage";
import type { NativeDBApis } from "@myoxus/storage/sqlite";

import { getSpaceDBPath } from "../workspace/meta";

const POOL = new DocStoragePool();
const PENDING_CONNECTIONS = new Map<string, Promise<void>>();

async function getIndexState(
  universalId: string,
): Promise<"ready" | "rebuilding" | "failed"> {
  const state = await POOL.ftsIndexState(universalId);
  if (state === "ready" || state === "rebuilding" || state === "failed") {
    return state;
  }
  throw new Error(`Native search index returned an invalid state: ${state}`);
}

export function getDocStoragePool(): InstanceType<typeof DocStoragePool> {
  return POOL;
}

export const storeHandlers: NativeDBApis = {
  connect: async (universalId: string) => {
    const pending = PENDING_CONNECTIONS.get(universalId);
    if (pending) {
      return pending;
    }

    // Shell and document renderers can open the same workspace concurrently.
    // Coalesce those requests before reaching the native pool, whose connecting
    // state deliberately rejects a second migration/open operation.
    const connection = (async () => {
      const { peer, type, id } = parseUniversalId(universalId);
      const dbPath = await getSpaceDBPath(peer, type, id);
      await mkdir(path.dirname(dbPath), { recursive: true });
      await POOL.connect(universalId, dbPath);
      await POOL.setSpaceId(universalId, id);
    })();
    PENDING_CONNECTIONS.set(universalId, connection);

    try {
      await connection;
    } finally {
      if (PENDING_CONNECTIONS.get(universalId) === connection) {
        PENDING_CONNECTIONS.delete(universalId);
      }
    }
  },
  disconnect: POOL.disconnect.bind(POOL),
  pushUpdate: POOL.pushUpdate.bind(POOL),
  getDocSnapshot: POOL.getDocSnapshot.bind(POOL),
  setDocSnapshot: POOL.setDocSnapshot.bind(POOL),
  getDocUpdates: POOL.getDocUpdates.bind(POOL),
  markUpdatesMerged: POOL.markUpdatesMerged.bind(POOL),
  deleteDoc: POOL.deleteDoc.bind(POOL),
  getDocClocks: POOL.getDocClocks.bind(POOL),
  getDocClock: POOL.getDocClock.bind(POOL),
  getDocIndexedClock: POOL.getDocIndexedClock.bind(POOL),
  setDocIndexedClock: POOL.setDocIndexedClock.bind(POOL),
  clearDocIndexedClock: POOL.clearDocIndexedClock.bind(POOL),
  getBlob: POOL.getBlob.bind(POOL),
  setBlob: POOL.setBlob.bind(POOL),
  deleteBlob: POOL.deleteBlob.bind(POOL),
  releaseBlobs: POOL.releaseBlobs.bind(POOL),
  listBlobs: POOL.listBlobs.bind(POOL),
  getPeerRemoteClocks: POOL.getPeerRemoteClocks.bind(POOL),
  getPeerRemoteClock: POOL.getPeerRemoteClock.bind(POOL),
  setPeerRemoteClock: POOL.setPeerRemoteClock.bind(POOL),
  getPeerPulledRemoteClocks: POOL.getPeerPulledRemoteClocks.bind(POOL),
  getPeerPulledRemoteClock: POOL.getPeerPulledRemoteClock.bind(POOL),
  setPeerPulledRemoteClock: POOL.setPeerPulledRemoteClock.bind(POOL),
  getPeerPushedClocks: POOL.getPeerPushedClocks.bind(POOL),
  getPeerPushedClock: POOL.getPeerPushedClock.bind(POOL),
  setPeerPushedClock: POOL.setPeerPushedClock.bind(POOL),
  clearClocks: POOL.clearClocks.bind(POOL),
  setBlobUploadedAt: POOL.setBlobUploadedAt.bind(POOL),
  getBlobUploadedAt: POOL.getBlobUploadedAt.bind(POOL),
  crawlDocData: POOL.crawlDocData.bind(POOL),
  ftsAddDocument: POOL.ftsAddDocument.bind(POOL),
  ftsDeleteDocument: POOL.ftsDeleteDocument.bind(POOL),
  ftsSearch: POOL.ftsSearch.bind(POOL),
  ftsGetDocument: POOL.ftsGetDocument.bind(POOL),
  ftsGetMatches: POOL.ftsGetMatches.bind(POOL),
  ftsFlushIndex: POOL.ftsFlushIndex.bind(POOL),
  ftsIndexState: getIndexState,
  ftsCompleteRebuild: POOL.ftsCompleteRebuild.bind(POOL),
  ftsFailRebuild: POOL.ftsFailRebuild.bind(POOL),
  ftsIndexVersion: POOL.ftsIndexVersion.bind(POOL),
};
