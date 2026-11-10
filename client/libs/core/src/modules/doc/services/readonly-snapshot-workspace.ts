// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import type { FeatureFlagService } from "../../feature-flag";
import type { WorkspaceFlavourProvider } from "../../workspace";
import { WorkspaceImpl } from "../../workspace/impls/workspace";
import { applyUpdate, Doc as YDoc } from "yjs";

/** Each selection owns an ephemeral store, readonly blobs and its disposal.
 * No live root-document updates, persisted workspace or sync writer enter it.
 */
export function createReadonlySnapshotWorkspace(
  workspaceId: string,
  featureFlagService?: FeatureFlagService,
  flavourProvider?: WorkspaceFlavourProvider,
) {
  let disposed = false;
  const collection = new WorkspaceImpl({
    id: workspaceId,
    rootDoc: new YDoc({ guid: workspaceId }),
    featureFlagService,
    blobSource: {
      name: "history",
      readonly: true,
      async get(key) {
        if (disposed) return null;
        const blob = await flavourProvider?.getWorkspaceBlob(workspaceId, key);
        return disposed ? null : (blob ?? null);
      },
      set() {
        return Promise.reject(new Error("Snapshot blobs are readonly"));
      },
      delete() {
        return Promise.reject(new Error("Snapshot blobs are readonly"));
      },
      list() {
        return Promise.resolve([]);
      },
    },
  });
  collection.meta.initialize();
  collection.doc.emit("sync", [true, collection.doc]);

  return {
    loadSnapshot(
      docId: string,
      snapshot: Uint8Array,
      options?: { readonly: boolean },
    ) {
      const page = collection.createDoc(docId).getStore();
      // A preparation consumer may edit only this detached in-memory Store;
      // the default remains readonly for all document/history previews.
      page.readonly = options?.readonly ?? true;
      page.load(() => {
        applyUpdate(page.spaceDoc, snapshot);
      });
      if (!page.root) throw new Error("Snapshot has no document root");
      return page;
    },
    dispose() {
      disposed = true;
      collection.dispose();
      collection.doc.destroy();
    },
  };
}
