import {
  createIdentifier,
  createORMClient,
  Framework,
  YjsDBAdapter,
} from "@myoxus/infra";
import { BehaviorSubject } from "rxjs";
import { describe, expect, test } from "vitest";
import { applyUpdate, Doc as YDoc, encodeStateAsUpdate } from "yjs";

import {
  Myoxus_WORKSPACE_DB_SCHEMA,
  type MyoxusWorkspaceDbSchema,
} from "../../db/schema";
import type { WorkspaceDBService } from "../../db/services/db";
import { FolderNode } from "../entities/folder-node";
import { FolderStore } from "./folder";

const MCP_FOLDER_INDEX_MAP = "myoxus$mcp_folder_index";
const YJS_TABLE_DELETE_FLAG = "$$DELETED";

const WorkspaceDBClient = createORMClient(Myoxus_WORKSPACE_DB_SCHEMA);
const WorkspaceDBServiceForTest = createIdentifier<WorkspaceDBService>(
  "WorkspaceDBServiceForTest",
);

function createFolderStoreHarness({ resolveStore = true, ready = true } = {}) {
  const foldersDoc = new YDoc({ guid: "db$folders" });
  const docProvider = {
    getDoc(guid: string) {
      if (guid === "folders") {
        return foldersDoc;
      }
      return new YDoc({ guid: `db$${guid}` });
    },
  };
  const db = new WorkspaceDBClient(
    new YjsDBAdapter(Myoxus_WORKSPACE_DB_SCHEMA, docProvider),
  );
  const ready$ = new BehaviorSubject(ready);
  const dbService = {
    db: { folders: Object.assign(db.folders, { isReady$: ready$ }) },
    getWorkspaceDbDoc(tableName: keyof MyoxusWorkspaceDbSchema & string) {
      expect(tableName).toBe("folders");
      return foldersDoc;
    },
  } as unknown as WorkspaceDBService;

  const framework = new Framework();
  framework.impl(WorkspaceDBServiceForTest, dbService);
  framework.store(FolderStore, [WorkspaceDBServiceForTest]);
  framework.entity(FolderNode, [FolderStore]);
  const store = resolveStore
    ? framework.provider().get(FolderStore)
    : undefined;

  return { db, dbService, foldersDoc, store, framework, ready$ };
}

describe("FolderStore MCP index", () => {
  test("keeps Extract's Workspace placeholder visible at the normal source root", () => {
    const { db, foldersDoc, store, framework } = createFolderStoreHarness();
    if (!store) throw new Error("FolderStore was not resolved");
    const folderId = store.createFolder(null, "Remaining folder", "a0");
    const placeholder = db.folders.create({
      type: "workspace",
      parentId: null,
      data: "target-workspace",
      targetWorkspaceId: "target-workspace",
      index: "a1",
    });
    const root = framework.provider().createEntity(FolderNode, { id: null });
    const children: string[][] = [];
    const subscription = root.children$.subscribe((rows) => {
      children.push(rows.map((row) => row.id!).sort());
    });
    try {
      expect(children.at(-1)).toEqual([folderId, placeholder.id].sort());
    } finally {
      subscription.unsubscribe();
      root.dispose();
      store.dispose();
      foldersDoc.destroy();
    }
  });

  test("hydrates an extracted root without an extra level and reparents the same folder through reload", () => {
    const { db, foldersDoc, store } = createFolderStoreHarness();
    if (!store) throw new Error("FolderStore was not resolved");
    const persisted = new YDoc();
    const children: string[][] = [];
    const subscription = store.watchNodeChildren(null).subscribe((rows) => {
      children.push(rows.map((row) => row.id).sort());
    });
    try {
      for (const [id, type, parentId, data, index] of [
        ["retained-root", "workspace-root", null, "Extracted folder", "a0"],
        ["movable", "folder", "retained-root", "Movable", "a0"],
        ["destination", "folder", "retained-root", "Destination", "a1"],
        ["root-link", "doc", "retained-root", "root-document", "a2"],
      ]) {
        const row = persisted.getMap(id!);
        for (const [key, value] of Object.entries({
          id,
          type,
          parentId,
          data,
          index,
        })) {
          row.set(key, value);
        }
      }
      // Remote hydration occurs after the root observer has subscribed.
      applyUpdate(foldersDoc, encodeStateAsUpdate(persisted));
      expect(children.at(-1)).toEqual(["destination", "movable", "root-link"]);
      expect(store.workspaceRootId).toBe("retained-root");
      const ids = db.folders.keys().sort();
      store.moveNode("movable", "destination", "a0");
      expect(children.at(-1)).toEqual(["destination", "root-link"]);
      store.moveNode("movable", null, "a3");
      expect(db.folders.get("movable")?.parentId).toBe("retained-root");
      expect(db.folders.keys().sort()).toEqual(ids);
      expect(children.at(-1)).toEqual(["destination", "movable", "root-link"]);
      expect(store.folderPathForLinkedDoc("root-document")).toEqual([]);
      const nested = store.createFolder(null, "Created at root", "a4");
      expect(db.folders.get(nested)?.parentId).toBe("retained-root");
      store.createLink(nested, "doc", "nested-document", "a0");
      expect(store.resolveTemplateFolder("nested-document")).toEqual({
        status: "resolved",
        folderId: nested,
        name: "Created at root",
        path: ["Created at root"],
      });
      const reloaded = createFolderStoreHarness();
      if (!reloaded.store)
        throw new Error("Reloaded FolderStore was not resolved");
      try {
        applyUpdate(reloaded.foldersDoc, encodeStateAsUpdate(foldersDoc));
        expect(reloaded.db.folders.get("movable")?.parentId).toBe(
          "retained-root",
        );
        expect(
          reloaded.db.folders.find({ type: "folder", data: "Movable" }),
        ).toHaveLength(1);
        expect(reloaded.store.workspaceRootId).toBe("retained-root");
      } finally {
        reloaded.store.dispose();
        reloaded.foldersDoc.destroy();
      }
    } finally {
      subscription.unsubscribe();
      store.dispose();
      foldersDoc.destroy();
      persisted.destroy();
    }
  });

  test("template placement requires one local link and complete, nonempty, acyclic folder ancestry", () => {
    const { db, foldersDoc, store } = createFolderStoreHarness();
    if (!store) throw new Error("FolderStore was not resolved");
    try {
      const root = store.createFolder(null, " Root ", "a0");
      const terminal = store.createFolder(root, " Destination ", "a1");
      expect(store.resolveTemplateFolder("target")).toEqual({
        status: "absent",
      });
      store.createLink(terminal, "doc", "target", "a2");
      const resolved = {
        status: "resolved",
        folderId: terminal,
        name: "Destination",
        path: ["Root", "Destination"],
      };
      expect(
        store.resolveTemplateFolder("target", terminal, "workspace"),
      ).toEqual(resolved);
      expect(store.resolveTemplateFolder("target", root, "workspace")).toEqual({
        status: "absent",
      });
      const foreign = db.folders.create({
        type: "doc",
        data: "target",
        parentId: root,
        targetWorkspaceId: "foreign",
        index: "a3",
      });
      expect(
        store.resolveTemplateFolder("target", terminal, "workspace"),
      ).toEqual(resolved);
      db.folders.update(foreign.id, { targetWorkspaceId: "workspace" });
      expect(
        store.resolveTemplateFolder("target", terminal, "workspace"),
      ).toEqual({ status: "ambiguous" });
      db.folders.delete(foreign.id);
      for (const parentId of [terminal, "missing", ""]) {
        db.folders.update(root, { parentId });
        expect(store.resolveTemplateFolder("target")).toEqual({
          status: "absent",
        });
      }
      db.folders.update(root, { parentId: null, data: "   " });
      expect(store.resolveTemplateFolder("target")).toEqual({
        status: "absent",
      });
      db.folders.update(root, { data: "Root", type: "doc" });
      expect(store.resolveTemplateFolder("target")).toEqual({
        status: "absent",
      });
    } finally {
      store.dispose();
      foldersDoc.destroy();
    }
  });

  test("hydrates before backfilling existing rows without exposing the MCP index as an ORM row", () => {
    for (const indexed of [false, true]) {
      const remote = createFolderStoreHarness({ resolveStore: false });
      const local = createFolderStoreHarness({
        resolveStore: false,
        ready: false,
      });
      const legacyFolder = remote.db.folders.create({
        parentId: null,
        type: "folder",
        data: "Legacy",
        index: "a0",
      });
      if (indexed) {
        const indexMap =
          remote.foldersDoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP);
        indexMap.set(YJS_TABLE_DELETE_FLAG, true);
        indexMap.set(legacyFolder.id, true);
      }
      let localWrites = 0;
      local.foldersDoc.on("update", (_update, _origin, _doc, transaction) => {
        if (transaction.local) localWrites++;
      });
      const store = local.framework.provider().get(FolderStore);
      try {
        expect(localWrites).toBe(0);
        applyUpdate(local.foldersDoc, encodeStateAsUpdate(remote.foldersDoc));
        expect(localWrites).toBe(0);
        local.ready$.next(true);
        expect(localWrites).toBe(indexed ? 0 : 1);
        const indexMap = local.foldersDoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP);
        expect(indexMap.get(YJS_TABLE_DELETE_FLAG)).toBe(true);
        expect(indexMap.get(legacyFolder.id)).toBe(true);
        expect(local.db.folders.keys()).toEqual([legacyFolder.id]);
        expect(local.db.folders.find()).toEqual([legacyFolder]);
      } finally {
        store.dispose();
        local.ready$.complete();
        remote.ready$.complete();
        local.foldersDoc.destroy();
        remote.foldersDoc.destroy();
      }
    }
  });

  test("maintains folder and link ids across create and recursive delete", () => {
    const { db, foldersDoc, store } = createFolderStoreHarness();
    const indexMap = foldersDoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP);
    if (!store) {
      throw new Error("FolderStore was not resolved");
    }

    const rootId = store.createFolder(null, "Projects", "a0");
    const childId = store.createFolder(rootId, "Client", "a1");
    store.createLink(childId, "doc", "doc-1", "a2");
    const link = db.folders.find({ parentId: childId })[0];
    if (!link) {
      throw new Error("Expected created document link");
    }

    expect(indexMap.get(YJS_TABLE_DELETE_FLAG)).toBe(true);
    expect(indexMap.get(rootId)).toBe(true);
    expect(indexMap.get(childId)).toBe(true);
    expect(indexMap.get(link.id)).toBe(true);
    expect(db.folders.keys()).toEqual([rootId, childId, link.id]);

    store.removeFolder(rootId);

    expect(indexMap.get(rootId)).toBeUndefined();
    expect(indexMap.get(childId)).toBeUndefined();
    expect(indexMap.get(link.id)).toBeUndefined();
    expect(db.folders.keys()).toEqual([]);
  });

  test("returns the folder ancestor path for linked documents", () => {
    const { store } = createFolderStoreHarness();
    if (!store) {
      throw new Error("FolderStore was not resolved");
    }

    const rootId = store.createFolder(null, "Projects", "a0");
    const childId = store.createFolder(rootId, "Client", "a1");
    const nestedId = store.createFolder(childId, "Research", "a2");
    store.createLink(nestedId, "doc", "doc-1", "a3");
    store.createLink(nestedId, "database", "doc-1", "a35");
    store.createLink(childId, "tag", "tag-1", "a4");

    expect(store.folderPathForLinkedDoc("doc-1")).toEqual([
      rootId,
      childId,
      nestedId,
    ]);
    expect(store.folderPathForLinkedTarget("database", "doc-1")).toEqual([
      rootId,
      childId,
      nestedId,
    ]);
    expect(store.folderPathForLinkedDoc("tag-1")).toEqual([]);
    expect(store.folderPathForLinkedDoc("missing-doc")).toEqual([]);
  });

  test("creates, moves, reloads, removes and cleans Database links without weakening cycle protection", () => {
    const { db, dbService, foldersDoc, store } = createFolderStoreHarness();
    if (!store) throw new Error("FolderStore was not resolved");

    const first = store.createFolder(null, "First", "a0");
    const second = store.createFolder(null, "Second", "a1");
    store.createLink(first, "database", "database-1", "a2");
    store.createLink(
      second,
      "database",
      "database-1",
      "a25",
      "00000000-0000-0000-0000-000000000123",
    );
    const link = db.folders.find({ type: "database", data: "database-1" })[0];
    if (!link) throw new Error("Expected Database folder link");

    store.moveNode(link.id, second, "a3");
    expect(store.folderPathForLinkedTarget("database", "database-1")).toEqual([
      second,
    ]);
    expect(
      store.folderPathForLinkedTarget(
        "database",
        "database-1",
        "00000000-0000-0000-0000-000000000123",
      ),
    ).toEqual([second]);
    expect(() => store.moveNode(second, second, "a4")).toThrow(
      "Cannot move a node to itself",
    );

    store.moveNode(link.id, second, "a5");
    expect(db.folders.get(link.id)?.index).toBe("a5");

    const reloadedFramework = new Framework();
    reloadedFramework.impl(WorkspaceDBServiceForTest, dbService);
    reloadedFramework.store(FolderStore, [WorkspaceDBServiceForTest]);
    const reloadedStore = reloadedFramework.provider().get(FolderStore);

    expect(
      reloadedStore.folderPathForLinkedTarget("database", "database-1"),
    ).toEqual([second]);
    expect(foldersDoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP).get(link.id)).toBe(
      true,
    );

    reloadedStore.removeLinksForTarget("database", "database-1");
    expect(db.folders.find({ type: "database", data: "database-1" })).toEqual([
      expect.objectContaining({
        targetWorkspaceId: "00000000-0000-0000-0000-000000000123",
      }),
    ]);
    expect(
      foldersDoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP).get(link.id),
    ).toBeUndefined();
  });
});
