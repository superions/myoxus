// SPDX-License-Identifier: AGPL-3.0-or-later

import "fake-indexeddb/auto";

import { deleteDB, openDB } from "idb";
import { afterEach, describe, expect, test } from "vitest";

import { IndexedDBBlobSource } from "../blob/impl/indexeddb.js";

const sourceName = "myoxus-blob-source-test";
const blobDatabaseName = `${sourceName}_blob`;
const mimeDatabaseName = `${sourceName}_blob_mime`;

afterEach(async () => {
  await Promise.all([deleteDB(blobDatabaseName), deleteDB(mimeDatabaseName)]);
});

async function seedExistingStore() {
  const blobDb = await openDB(blobDatabaseName, undefined, {
    upgrade(db) {
      db.createObjectStore("blob");
    },
  });
  await blobDb.put("blob", new TextEncoder().encode("existing").buffer, "old");
  blobDb.close();

  const mimeDb = await openDB(mimeDatabaseName, undefined, {
    upgrade(db) {
      db.createObjectStore("blob_mime");
    },
  });
  await mimeDb.put("blob_mime", "text/plain", "old");
  mimeDb.close();
}

describe("IndexedDBBlobSource", () => {
  test("retains the existing database and object-store contract", async () => {
    await seedExistingStore();
    const source = new IndexedDBBlobSource(sourceName);

    const existing = await source.get("old");
    expect(existing?.type).toBe("text/plain");
    expect(await existing?.text()).toBe("existing");

    await source.set("new", new Blob(["created"], { type: "text/markdown" }));
    expect((await source.list()).sort()).toEqual(["new", "old"]);
    expect(await (await source.get("new"))?.text()).toBe("created");

    await source.delete("old");
    expect(await source.get("old")).toBeNull();
    expect(await source.list()).toEqual(["new"]);

    await source.close();
  });
});
