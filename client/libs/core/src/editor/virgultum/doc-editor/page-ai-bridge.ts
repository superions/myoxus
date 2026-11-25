// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { insertFromMarkdown } from "@myoxus/core/editor/utils";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { resolveLinkToDoc } from "@myoxus/core/modules/navigation";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { parsePageDoc } from "@myoxus/reader";
import type { NotificationService } from "@virgultum/core/services";
import type { Store } from "@virgultum/core/store";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";

import { chatI18n } from "../../ai/components/chat-i18n";
import { AIProvider } from "../../ai/provider";
import { reportResponse } from "../../ai/utils/action-reporter";
import { applyPatchToDoc } from "../../ai/utils/apply-model/apply-patch-to-doc";
import { diffMarkdown } from "../../ai/utils/apply-model/markdown-diff";

/**
 * Store-backed editing bridge allowing Document AI Chat to operate on Page
 * documents without requiring an imperative EditorHost mount.
 */
export interface PageAiBridge {
  readonly store: Store;
  readonly docId: string;
  readonly workspaceId: string;
  readonly hasSelection: () => boolean;
  readonly insertMarkdown: (markdown: string) => Promise<boolean>;
  readonly replaceSelection: (markdown: string) => Promise<boolean>;
  readonly saveAsDoc: (markdown: string, title?: string) => Promise<boolean>;
  readonly applyDocUpdate: (op: string, updates: string) => Promise<boolean>;
  readonly openDocLink: (url: string) => boolean;
  readonly openDoc: (docId: string) => void;
}

export interface PageAiBridgeOptions {
  store: Store;
  getSelectedBlockIds: () => string[];
  getActiveBlockId: () => string | null;
  notificationService: NotificationService;
  peekViewService: PeekViewService;
  serverBaseUrl: string;
  openDoc: (docId: string) => void;
}

function resolveInsertionTarget(
  store: Store,
  selectedBlockIds: string[],
  activeBlockId: string | null,
): { parentId: string; index: number } | null {
  const anchorId = selectedBlockIds.at(-1) ?? activeBlockId ?? undefined;
  if (anchorId) {
    const model = store.getModelById(anchorId);
    const parent = model ? store.getParent(model) : null;
    if (model && parent && parent.id !== store.root?.id) {
      const idx = parent.children.findIndex((child) => child.id === model.id);
      if (idx >= 0) {
        return { parentId: parent.id, index: idx + 1 };
      }
    }
  }

  const firstNote = store.getBlocksByFlavour("myoxus:note")[0]?.model;
  if (!firstNote) return null;
  return { parentId: firstNote.id, index: firstNote.children.length };
}

export function createPageAiBridge(options: PageAiBridgeOptions): PageAiBridge {
  const {
    store,
    getSelectedBlockIds,
    getActiveBlockId,
    notificationService,
    peekViewService,
    serverBaseUrl,
    openDoc,
  } = options;

  return {
    store,
    docId: store.id,
    workspaceId: store.workspace.id,
    openDoc,
    hasSelection: () => getSelectedBlockIds().length > 0,

    insertMarkdown: async (markdown: string) => {
      if (store.readonly || !markdown.trim()) return false;
      const target = resolveInsertionTarget(
        store,
        getSelectedBlockIds(),
        getActiveBlockId(),
      );
      if (!target) return false;
      reportResponse("result:insert");
      store.captureSync();
      const inserted = await insertFromMarkdown(
        undefined,
        markdown,
        store,
        target.parentId,
        target.index,
      );
      store.captureSync();
      return inserted.length > 0;
    },

    replaceSelection: async (markdown: string) => {
      if (store.readonly || !markdown.trim()) return false;
      const selectedIds = getSelectedBlockIds();
      const selectedModels = selectedIds
        .map((id) => store.getModelById(id))
        .filter(
          (model): model is NonNullable<typeof model> =>
            Boolean(model) &&
            model!.id !== store.root?.id &&
            !store.hasFixedText(model!),
        );
      const first = selectedModels[0];
      const firstParent = first ? store.getParent(first) : null;
      if (!first || !firstParent) {
        const target = resolveInsertionTarget(
          store,
          selectedIds,
          getActiveBlockId(),
        );
        if (!target) return false;
        reportResponse("result:replace");
        store.captureSync();
        const inserted = await insertFromMarkdown(
          undefined,
          markdown,
          store,
          target.parentId,
          target.index,
        );
        store.captureSync();
        return inserted.length > 0;
      }
      const insertIndex = firstParent.children.findIndex(
        (child) => child.id === first.id,
      );
      if (insertIndex < 0) return false;
      reportResponse("result:replace");
      store.captureSync();
      const inserted = await insertFromMarkdown(
        undefined,
        markdown,
        store,
        firstParent.id,
        insertIndex,
      );
      if (inserted.length > 0) {
        store.transact(() => {
          for (const model of selectedModels) {
            if (store.getModelById(model.id) === model) {
              store.deleteBlock(model);
            }
          }
        });
      }
      store.captureSync();
      return inserted.length > 0;
    },

    saveAsDoc: async (markdown: string, title?: string) => {
      if (!markdown.trim()) return false;
      reportResponse("result:add-page");
      if (title) {
        const { docId } = await MarkdownTransformer.importMarkdownToDoc({
          collection: store.workspace,
          schema: getMyoxusWorkspaceSchema(),
          markdown,
          fileName: title,
          extensions: getStoreManager().config.init().value.get("store"),
        });
        if (!docId) return false;
        openDoc(docId);
        return true;
      }

      const workspace = store.workspace;
      const newDoc = workspace.createDoc().getStore();
      try {
        newDoc.load();
        const rootId = newDoc.addBlock("myoxus:page");
        newDoc.addBlock("myoxus:surface", {}, rootId);
        const noteId = newDoc.addBlock("myoxus:note", {}, rootId);
        await insertFromMarkdown(undefined, markdown, newDoc, noteId, 0);
        if (!newDoc.getModelById(noteId)?.children.length) {
          throw new Error("The saved answer has no importable content");
        }
      } catch (error) {
        workspace.removeDoc(newDoc.id);
        console.error(error);
        notificationService.toast(
          chatI18n()["com.myoxus.workspace-home.layout.save-failed"](),
        );
        return false;
      }
      openDoc(newDoc.id);
      return true;
    },

    applyDocUpdate: async (op: string, updates: string) => {
      if (store.readonly) return false;
      const changedMarkdown = await AIProvider.context?.applyDocUpdates(
        store.workspace.id,
        store.id,
        op,
        updates,
      );
      if (!changedMarkdown || store.readonly) return false;

      const parsed = parsePageDoc({
        doc: store.doc.spaceDoc,
        workspaceId: store.workspace.id,
        buildBlobUrl: (blobId: string) =>
          `/${store.workspace.id}/blobs/${blobId}`,
        buildDocUrl: (id: string) => `/workspace/${store.workspace.id}/${id}`,
        aiEditable: true,
      });
      const { patches } = diffMarkdown(parsed.md, changedMarkdown);
      if (!patches.length) return false;
      store.captureSync();
      await applyPatchToDoc(store, patches, undefined);
      store.captureSync();
      return true;
    },

    openDocLink: (url: string) => {
      const link = resolveLinkToDoc(url, serverBaseUrl);
      if (!link) return false;
      const { docId, workspaceId, ...params } = link;
      void peekViewService.peekView
        .open({
          type: "doc",
          docRef: { docId, workspaceId },
          ...params,
        })
        .catch(console.error);
      return true;
    },
  };
}
