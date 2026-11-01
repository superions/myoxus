import "fake-indexeddb/auto";

import { deleteDB } from "idb";

import { expect, test, vitest } from "vitest";
import { Awareness } from "y-protocols/awareness.js";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { AwarenessFrontend } from "../frontend/awareness";
import { DocFrontend } from "../frontend/doc";
import { BroadcastChannelAwarenessStorage } from "../impls/broadcast-channel/awareness";
import { IndexedDBDocStorage, IndexedDBDocSyncStorage } from "../impls/idb";
import { DummyDocSyncStorage } from "../storage/dummy/doc-sync";
import { AwarenessSyncImpl } from "../sync/awareness";
import { DocSyncImpl } from "../sync/doc";
import { expectYjsEqual } from "./utils";

test("doc", async () => {
  const doc1 = new YDoc({
    guid: "test-doc",
  });
  doc1.getMap("test").set("hello", "world");

  const docStorage = new IndexedDBDocStorage({
    id: "ws1",
    flavour: "a",
    type: "workspace",
  });

  docStorage.connection.connect();

  await docStorage.connection.waitForConnected();

  const frontend1 = new DocFrontend(docStorage, DocSyncImpl.dummy);
  frontend1.start();
  frontend1.connectDoc(doc1);
  await vitest.waitFor(async () => {
    const doc = await docStorage.getDoc("test-doc");
    expectYjsEqual(doc!.bin, {
      test: {
        hello: "world",
      },
    });
  });

  const doc2 = new YDoc({
    guid: "test-doc",
  });
  const frontend2 = new DocFrontend(docStorage, DocSyncImpl.dummy);
  frontend2.start();
  frontend2.connectDoc(doc2);

  await vitest.waitFor(async () => {
    expectYjsEqual(doc2, {
      test: {
        hello: "world",
      },
    });
  });
});

test("updateAndWaitForSaved bypasses unrelated queued work and persists locally", async () => {
  const docId = "local-save-ack-doc";
  const doc = new YDoc({ guid: docId });
  doc.getMap("test").set("value", "initial");
  const docStorage = new IndexedDBDocStorage({
    id: `ws-local-save-ack-${Date.now()}`,
    flavour: "a",
    type: "workspace",
  });

  docStorage.connection.connect();
  await docStorage.connection.waitForConnected();

  const frontend = new DocFrontend(docStorage, DocSyncImpl.dummy);
  frontend.start();
  frontend.connectDoc(doc);
  await vitest.waitFor(async () => {
    expectYjsEqual((await docStorage.getDoc(docId))!.bin, {
      test: { value: "initial" },
    });
  });

  const blockedDocId = "blocked-load-doc";
  const getDoc = docStorage.getDoc.bind(docStorage);
  let blockedLoadStarted = false;
  vitest.spyOn(docStorage, "getDoc").mockImplementation(async (requestedId) => {
    if (requestedId === blockedDocId) {
      blockedLoadStarted = true;
      return new Promise(() => {});
    }
    return getDoc(requestedId);
  });
  frontend.connectDoc(new YDoc({ guid: blockedDocId }));

  await vitest.waitFor(() => {
    expect(blockedLoadStarted).toBe(true);
  });

  await frontend.updateAndWaitForSaved(docId, () => {
    doc.getMap("test").set("value", "persisted");
  });
  expectYjsEqual((await docStorage.getDoc(docId))!.bin, {
    test: { value: "persisted" },
  });

  frontend.stop();
});

test("saveDetachedUpdateAndWaitForSynced persists a pre-connection update", async () => {
  const docId = "detached-create-update";
  const doc = new YDoc({ guid: docId });
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  doc.getMap("test").set("value", "created-before-connect");
  const docStorage = new IndexedDBDocStorage({
    id: `ws-detached-save-${Date.now()}`,
    flavour: "a",
    type: "workspace",
  });

  docStorage.connection.connect();
  await docStorage.connection.waitForConnected();
  const frontend = new DocFrontend(
    docStorage,
    new DocSyncImpl(
      { local: docStorage, remotes: {} },
      new DummyDocSyncStorage(),
    ),
  );
  frontend.start();

  await frontend.saveDetachedUpdateAndWaitForSynced(docId, updates[0]!);
  expectYjsEqual((await docStorage.getDoc(docId))!.bin, {
    test: { value: "created-before-connect" },
  });

  frontend.stop();
});

test("deleteDoc removes persisted doc data", async () => {
  const doc = new YDoc({
    guid: "delete-test-doc",
  });
  doc.getMap("test").set("trash", "permanent");

  const docStorage = new IndexedDBDocStorage({
    id: `ws-delete-${Date.now()}`,
    flavour: "a",
    type: "workspace",
  });

  docStorage.connection.connect();
  await docStorage.connection.waitForConnected();

  const frontend = new DocFrontend(docStorage, DocSyncImpl.dummy);
  frontend.start();
  frontend.connectDoc(doc);

  await vitest.waitFor(async () => {
    expect(await docStorage.getDoc("delete-test-doc")).not.toBeNull();
  });

  await frontend.deleteDoc("delete-test-doc");

  await vitest.waitFor(async () => {
    expect(await docStorage.getDoc("delete-test-doc")).toBeNull();
  });
});

test("stopping the document frontend is not reported as a runtime error", async () => {
  const error = vitest.spyOn(console, "error").mockImplementation(() => {});
  const docStorage = new IndexedDBDocStorage({
    id: `ws-stop-${Date.now()}`,
    flavour: "a",
    type: "workspace",
  });
  const frontend = new DocFrontend(docStorage, DocSyncImpl.dummy);

  frontend.start();
  frontend.stop();
  await Promise.resolve();
  await Promise.resolve();

  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});

test("awareness", async () => {
  const storage1 = new BroadcastChannelAwarenessStorage({
    id: "ws1:a",
  });

  const storage2 = new BroadcastChannelAwarenessStorage({
    id: "ws1:b",
  });

  storage1.connection.connect();
  storage2.connection.connect();

  await storage1.connection.waitForConnected();
  await storage2.connection.waitForConnected();

  // peer a
  const docA = new YDoc({ guid: "test-doc" });
  docA.clientID = 1;
  const awarenessA = new Awareness(docA);

  // peer b
  const docB = new YDoc({ guid: "test-doc" });
  docB.clientID = 2;
  const awarenessB = new Awareness(docB);

  // peer c
  const docC = new YDoc({ guid: "test-doc" });
  docC.clientID = 3;
  const awarenessC = new Awareness(docC);

  {
    const sync = new AwarenessSyncImpl({
      local: storage1,
      remotes: {
        b: storage2,
      },
    });
    const frontend = new AwarenessFrontend(sync);
    frontend.connectAwareness(awarenessA);
    frontend.connectAwareness(awarenessB);
  }
  {
    const sync = new AwarenessSyncImpl({
      local: storage2,
      remotes: {
        a: storage1,
      },
    });
    const frontend = new AwarenessFrontend(sync);
    frontend.connectAwareness(awarenessC);
  }

  awarenessA.setLocalState({
    hello: "world",
  });

  await vitest.waitFor(() => {
    expect(awarenessB.getStates().get(1)).toEqual({
      hello: "world",
    });
    expect(awarenessC.getStates().get(1)).toEqual({
      hello: "world",
    });
  });

  awarenessB.setLocalState({
    foo: "bar",
  });

  await vitest.waitFor(() => {
    expect(awarenessA.getStates().get(2)).toEqual({
      foo: "bar",
    });
    expect(awarenessC.getStates().get(2)).toEqual({
      foo: "bar",
    });
  });

  awarenessC.setLocalState({
    baz: "qux",
  });

  await vitest.waitFor(() => {
    expect(awarenessA.getStates().get(3)).toEqual({
      baz: "qux",
    });
    expect(awarenessB.getStates().get(3)).toEqual({
      baz: "qux",
    });
  });
});

test("permanent cache deletion removes snapshots, updates and peer clocks and blocks late writes", async () => {
  const options = {
    id: `delete-cache-${crypto.randomUUID()}`,
    flavour: "a",
    type: "workspace" as const,
  };
  const local = new IndexedDBDocStorage(options);
  const clocks = new IndexedDBDocSyncStorage(options);
  local.connection.connect();
  clocks.connection.connect();
  const doc = new YDoc({ guid: "deleted" });
  doc.getMap("content").set("value", "saved content");
  try {
    await Promise.all([
      local.connection.waitForConnected(),
      clocks.connection.waitForConnected(),
    ]);
    const update = { docId: doc.guid, bin: encodeStateAsUpdate(doc) };
    await local.pushDocUpdate(update);
    await local.getDoc(doc.guid); // Materialize the snapshot too.
    await clocks.setPeerRemoteClock("server", {
      docId: doc.guid,
      timestamp: new Date(),
    });
    await clocks.setPeerPushedClock("server", {
      docId: doc.guid,
      timestamp: new Date(),
    });
    await local.deleteDoc(doc.guid);
    expect(await local.getDoc(doc.guid)).toBeNull();
    expect(await local.getDocTimestamps()).toEqual({});
    expect(await clocks.getPeerRemoteClocks("server")).toEqual({});
    expect(await local.db.getAll("snapshots")).toEqual([]);
    expect(await local.db.getAll("updates")).toEqual([]);
    await expect(local.pushDocUpdate(update)).rejects.toThrow(
      "permanently deleted",
    );
    await local.deleteDoc(doc.guid); // Idempotent retry.
  } finally {
    doc.destroy();
    clocks.connection.disconnect();
    local.connection.disconnect();
    await deleteDB(`${options.flavour}:${options.type}:${options.id}`);
  }
});

test("a rejected late save for a deleted leaf does not stop unrelated document saves", async () => {
  const options = {
    id: `delete-late-save-${crypto.randomUUID()}`,
    flavour: "a",
    type: "workspace" as const,
  };
  const local = new IndexedDBDocStorage(options);
  local.connection.connect();
  await local.connection.waitForConnected();
  const frontend = new DocFrontend(local, DocSyncImpl.dummy);
  const deleted = new YDoc({ guid: "deleted-leaf" });
  const healthy = new YDoc({ guid: "healthy-leaf" });
  deleted.getMap("content").set("value", "stale content");
  healthy.getMap("content").set("value", "keep saving");
  try {
    await local.deleteDoc(deleted.guid);
    frontend.start();
    frontend.connectDoc(deleted);
    frontend.connectDoc(healthy);
    await vitest.waitFor(async () =>
      expectYjsEqual((await local.getDoc(healthy.guid))!.bin, {
        content: { value: "keep saving" },
      }),
    );
    expect(await local.getDoc(deleted.guid)).toBeNull();
    healthy.getMap("content").set("value", "still saving");
    await vitest.waitFor(async () =>
      expectYjsEqual((await local.getDoc(healthy.guid))!.bin, {
        content: { value: "still saving" },
      }),
    );
  } finally {
    frontend.stop();
    deleted.destroy();
    healthy.destroy();
    local.connection.disconnect();
    await deleteDB(`${options.flavour}:${options.type}:${options.id}`);
  }
});
