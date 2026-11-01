// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { describe, expect, test, vi } from "vitest";
import {
  Array as YArray,
  Doc as YDoc,
  Map as YMap,
  encodeStateVector,
} from "yjs";

import { WorkspaceMetaImpl } from "./meta";
import type { DocImpl } from "./doc";
import { WorkspaceImpl } from "./workspace";

function yDocMeta(id: string, title: string) {
  return new YMap<unknown>([
    ["id", id],
    ["title", title],
    ["createDate", 1],
    ["tags", []],
  ]);
}

describe("WorkspaceMetaImpl", () => {
  test("indexes membership once per structural transaction and rebinds document observers", () => {
    const rootDoc = new YDoc();
    const pages = new YArray<YMap<unknown>>();
    const initialMaps = Array.from({ length: 200 }, (_, index) =>
      yDocMeta(`doc-${index}`, `Title ${index}`),
    );
    initialMaps.push(yDocMeta("doc-0", "Ignored duplicate"));
    pages.push(initialMaps);
    rootDoc.getMap("meta").set("pages", pages);

    const originalGet = YMap.prototype.get;
    let idReads = 0;
    const getSpy = vi.spyOn(YMap.prototype, "get").mockImplementation(function (
      this: YMap<unknown>,
      key: string,
    ) {
      if (key === "id") idReads += 1;
      return originalGet.call(this, key);
    });

    try {
      const meta = new WorkspaceMetaImpl(rootDoc);
      expect(idReads).toBe(201);
      expect(meta.getDocMetaSnapshot("doc-0").title).toBe("Title 0");
      expect(meta.getDocMeta("doc-199")?.title).toBe("Title 199");

      const updates: number[] = [];
      const added: string[] = [];
      const removed: string[] = [];
      const observedTitles: Array<string | undefined> = [];
      meta.docMetaUpdated.subscribe(() => updates.push(updates.length));
      meta.docMetaAdded.subscribe((id) => added.push(id));
      meta.docMetaRemoved.subscribe((id) => removed.push(id));
      const observed = meta
        .watchDocMeta("doc-0")
        .subscribe((value) => observedTitles.push(value.title));

      idReads = 0;
      rootDoc.transact(() => {
        initialMaps[0].set("title", "Updated zero");
        initialMaps[1].set("title", "Updated one");
      });
      expect(idReads).toBe(0);
      expect(updates).toHaveLength(1);
      expect(meta.getDocMetaSnapshot("doc-0").title).toBe("Updated zero");

      const replacementDoc = yDocMeta("doc-0", "Replacement title");
      const addedDoc = yDocMeta("new-doc", "New title");
      const replacementPages = new YArray<YMap<unknown>>();
      replacementPages.push([replacementDoc, addedDoc]);
      idReads = 0;
      rootDoc.getMap("meta").set("pages", replacementPages);

      expect(idReads).toBe(2);
      expect(updates).toHaveLength(2);
      expect(added).toEqual(["new-doc"]);
      expect(removed).toHaveLength(199);
      expect(removed).not.toContain("doc-0");
      expect(observedTitles.at(-1)).toBe("Replacement title");

      const emissionsAfterReplacement = observedTitles.length;
      initialMaps[0].set("title", "Detached title");
      expect(observedTitles).toHaveLength(emissionsAfterReplacement);
      replacementDoc.set("title", "Rebound title");
      expect(observedTitles.at(-1)).toBe("Rebound title");

      idReads = 0;
      replacementPages.delete(1, 1);
      expect(idReads).toBe(1);
      expect(updates).toHaveLength(4);
      expect(removed.at(-1)).toBe("new-doc");
      expect(meta.getDocMeta("new-doc")).toBeUndefined();
      observed.unsubscribe();
    } finally {
      getSpy.mockRestore();
    }
  });
});

describe("WorkspaceImpl", () => {
  test("keeps a complete descriptor catalogue while leaf runtimes stay demand-driven", () => {
    const rootDoc = new YDoc();
    const preloadedMeta = new WorkspaceMetaImpl(rootDoc);
    preloadedMeta.initialize();
    for (let index = 0; index < 50; index++) {
      preloadedMeta.addDocMeta({
        id: `catalogue-${index}`,
        title: `Catalogue ${index}`,
        createDate: index,
        tags: [],
      });
    }
    const loadedLeafIds: string[] = [];
    const connectedAwarenessIds: number[] = [];
    const workspace = new WorkspaceImpl({
      rootDoc,
      onLoadDoc: (doc) => {
        if (doc !== rootDoc) loadedLeafIds.push(doc.guid);
      },
      onLoadAwareness: (awareness) =>
        connectedAwarenessIds.push(awareness.clientID),
    });
    const descriptors = [...workspace.docs.values()] as DocImpl[];

    expect(descriptors).toHaveLength(50);
    expect(descriptors.map((doc) => doc.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `catalogue-${index}`),
    );
    expect(descriptors.every((doc) => !doc.runtimeInitialized)).toBe(true);
    expect(descriptors.map((doc) => doc.meta?.title)).toHaveLength(50);
    expect(descriptors.every((doc) => !doc.runtimeInitialized)).toBe(true);

    const opened = descriptors[0];
    const initializationOrder: string[] = [];
    opened.onRuntimeInitialized((awarenessStore) => {
      initializationOrder.push("writer-info");
      awarenessStore.awareness.setLocalStateField("user", {
        name: "Runtime Owner",
      });
    });
    const firstRuntime = opened.spaceDoc;
    expect(opened.spaceDoc).toBe(firstRuntime);
    expect(descriptors.filter((doc) => doc.runtimeInitialized)).toEqual([
      opened,
    ]);
    expect(loadedLeafIds).toEqual([]);

    opened.load();
    expect(initializationOrder).toEqual(["writer-info"]);
    expect(loadedLeafIds).toEqual([opened.id]);
    expect(connectedAwarenessIds).toEqual([
      opened.awarenessStore.awareness.clientID,
    ]);
    expect(opened.awarenessStore.awareness.getLocalState()?.user).toEqual({
      name: "Runtime Owner",
    });

    const disposedUnopened = descriptors[1];
    disposedUnopened.dispose();
    expect(disposedUnopened.runtimeInitialized).toBe(false);
    const removedUnopened = descriptors[2];
    workspace.removeDoc(removedUnopened.id);
    expect(removedUnopened.runtimeInitialized).toBe(false);

    const created = workspace.createDoc("created-on-demand") as DocImpl;
    expect(created.runtimeInitialized).toBe(false);
    expect(workspace.docs.get(created.id)).toBe(created);
    created.getStore({ id: created.id });
    expect(created.runtimeInitialized).toBe(true);

    workspace.dispose();
    expect(descriptors[3].runtimeInitialized).toBe(false);
  });

  test("materializes preloaded documents without changing root state", () => {
    const rootDoc = new YDoc();
    const preloadedMeta = new WorkspaceMetaImpl(rootDoc);
    const docId = "external-document-before-collection";
    const aliasedDocId = "document-with-storage-alias";
    const storageAlias = new YDoc({ guid: "legacy-storage-identity" });
    preloadedMeta.initialize();
    preloadedMeta.addDocMeta({
      id: docId,
      title: "Created by another connected client",
      createDate: Date.now(),
      tags: [],
    });
    preloadedMeta.addDocMeta({
      id: aliasedDocId,
      title: "Document retaining a storage alias",
      createDate: Date.now(),
      tags: [],
    });
    rootDoc.getMap("spaces").set(aliasedDocId, storageAlias);
    const stateBeforeConstruction = encodeStateVector(rootDoc);
    const rootUpdates: Uint8Array[] = [];
    rootDoc.on("update", (update) => rootUpdates.push(update));

    const workspace = new WorkspaceImpl({ rootDoc });

    expect(workspace.docs.has(docId)).toBe(true);
    expect(workspace.getDoc(docId)?.id).toBe(docId);
    expect(rootDoc.getMap("spaces").has(docId)).toBe(false);
    expect(rootDoc.getMap("spaces").get(aliasedDocId)).toBe(storageAlias);

    workspace.dispose();

    expect(rootUpdates).toHaveLength(0);
    expect(encodeStateVector(rootDoc)).toEqual(stateBeforeConstruction);
  });

  test("explicit document creation still registers the new root member", () => {
    const rootDoc = new YDoc();
    const workspace = new WorkspaceImpl({ rootDoc });
    workspace.meta.initialize();
    const rootUpdates: Uint8Array[] = [];
    rootDoc.on("update", (update) => rootUpdates.push(update));

    const doc = workspace.createDoc("explicit-new-document");

    expect(doc.id).toBe("explicit-new-document");
    expect(workspace.meta.getDocMeta(doc.id)?.id).toBe(doc.id);
    expect(workspace.docs.get(doc.id)).toBe(doc);
    expect(rootDoc.getMap("spaces").has(doc.id)).toBe(false);
    expect(rootUpdates.length).toBeGreaterThan(0);
  });

  test("removeDoc removes root metadata even when the document body is not loaded", () => {
    const workspace = new WorkspaceImpl({ rootDoc: new YDoc() });
    const docId = "unloaded-trash-doc";

    workspace.meta.initialize();
    workspace.meta.addDocMeta({
      id: docId,
      title: "Unloaded trash doc",
      createDate: Date.now(),
      tags: [],
    });
    workspace.blockCollections.delete(docId);

    workspace.removeDoc(docId);

    expect(workspace.meta.getDocMeta(docId)).toBeUndefined();
    expect(workspace.docs.has(docId)).toBe(false);
  });
});
