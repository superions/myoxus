import "fake-indexeddb/auto";

import { openDB } from "idb";
import { describe, expect, test } from "vitest";

import {
  deleteRegisteredCloudDatabases,
  inspectRegisteredCloudDatabases,
} from "../impls/cloud/web-cloud-cache";

async function createCloudDatabase(
  name: string,
  {
    pendingBlob = false,
    pendingDocument = false,
  }: { pendingBlob?: boolean; pendingDocument?: boolean } = {},
) {
  const db = await openDB(name, 1, {
    upgrade(database) {
      database.createObjectStore("blobs", { keyPath: "key" });
      database.createObjectStore("blobSync", {
        keyPath: ["peer", "key"],
      });
      database.createObjectStore("clocks", { keyPath: "docId" });
      database.createObjectStore("peerClocks", {
        keyPath: ["peer", "docId"],
      });
    },
  });
  const transaction = db.transaction(
    ["blobs", "blobSync", "clocks", "peerClocks"],
    "readwrite",
  );
  const timestamp = new Date("2026-07-27T00:00:00Z");
  await transaction.objectStore("clocks").put({
    docId: "doc-a",
    timestamp,
  });
  await transaction.objectStore("peerClocks").put({
    peer: "cloud:server",
    docId: "doc-a",
    pushedClock: pendingDocument ? new Date(0) : timestamp,
  });
  await transaction.objectStore("blobs").put({
    key: "blob-a",
    deletedAt: null,
  });
  await transaction.objectStore("blobSync").put({
    peer: "cloud:server",
    key: "blob-a",
    uploadedAt: pendingBlob ? null : timestamp,
  });
  await transaction.done;
  db.close();
}

describe("registered Browser Web Cloud cache reset", () => {
  test.each([
    ["clean", false, false, 0, 0],
    ["pending document", false, true, 0, 1],
    ["pending blob", true, false, 1, 0],
  ] as const)(
    "classifies %s state from persisted sync metadata",
    async (_label, pendingBlob, pendingDocument, blobs, documents) => {
      const name = `cloud:workspace:${crypto.randomUUID()}`;
      await createCloudDatabase(name, { pendingBlob, pendingDocument });

      await expect(
        inspectRegisteredCloudDatabases([{ name, peerIds: ["cloud:server"] }]),
      ).resolves.toEqual({
        existingDatabases: [name],
        pendingBlobs: blobs,
        pendingDocuments: documents,
      });
      await deleteRegisteredCloudDatabases([name]);
    },
  );

  test("deletes only exact registered names and tolerates an already deleted cache", async () => {
    const target = `cloud:workspace:${crypto.randomUUID()}`;
    const foreign = `foreign:${crypto.randomUUID()}`;
    await createCloudDatabase(target);
    await createCloudDatabase(foreign);

    await deleteRegisteredCloudDatabases([target]);
    await deleteRegisteredCloudDatabases([target]);

    const names = new Set(
      (await indexedDB.databases()).flatMap((database) =>
        database.name ? [database.name] : [],
      ),
    );
    expect(names.has(target)).toBe(false);
    expect(names.has(foreign)).toBe(true);
    await deleteRegisteredCloudDatabases([foreign]);
  });

  test("reports an open exact target as blocked instead of skipping it", async () => {
    const target = `cloud:workspace:${crypto.randomUUID()}`;
    const openHandle = await openDB(target, 1, {
      upgrade(database) {
        database.createObjectStore("keep-open");
      },
    });

    await expect(deleteRegisteredCloudDatabases([target])).rejects.toThrow(
      /blocked/,
    );

    openHandle.close();
    await deleteRegisteredCloudDatabases([target]);
  });
});
