// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createTaskReferenceInserter } from "@myoxus/core/modules/database/tasks/task-reference-insertion";
import { DocLinksService } from "@myoxus/core/modules/doc-link";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { GuardService } from "@myoxus/core/modules/permissions";
import type { BlockStdScope } from "@virgultum/editor/std";
import type { BlockModel } from "@virgultum/editor/store";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { snapshotTaskCaptureSelection } from "./task-capture-selection";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { getSelectedModelsCommand } from "@virgultum/editor/shared/commands";
import {
  editorMessage,
  DocModeProvider,
  type ToolbarAction,
} from "@virgultum/editor/shared/services";

/** Canvas editing retains a surface Note selection alongside its text range.
 * Capture consumes only native text/block selections, never that Note shell.
 */
export function taskCaptureModels(std: BlockStdScope): BlockModel[] {
  const [ok, { selectedModels = [] }] = std.command.exec(
    getSelectedModelsCommand,
    { types: ["text", "block"] },
  );
  return ok ? selectedModels : [];
}

/** Freeze loaded immutable identity alongside text, before any permission await. */
export async function openTaskCapture(
  framework: FrameworkProvider,
  std: BlockStdScope,
  models: BlockModel[],
  onClose?: () => void,
  mode: "capture" | "insert" = "capture",
): Promise<boolean> {
  const activeElement = document.activeElement;
  const returnFocusRef = {
    current:
      activeElement instanceof HTMLElement &&
      std.host.contains(activeElement) &&
      !activeElement.closest("[data-range-sync-exclude]")
        ? activeElement
        : (std.host.querySelector<HTMLElement>('[contenteditable="true"]') ??
          std.host),
  };
  const source = snapshotTaskCaptureSelection(std, models);
  if (!source) return false;
  const openingMode =
    std.getOptional(DocModeProvider)?.getEditorMode() ?? "page";
  const servers = framework.get(WorkspaceServerService);
  const sourceServer = servers.server;
  const sourceAccount = sourceServer?.account$.value;
  if (!sourceServer || !sourceAccount) return false;
  const sourceWorkspaceId = std.workspace.id;
  const sourceHost = std.host;
  const openingOwnerIdentity = JSON.stringify([
    sourceServer.id,
    sourceServer.baseUrl,
    sourceAccount.id,
    sourceWorkspaceId,
  ]);
  const isCurrent = () => {
    const currentServer = servers.server;
    return Boolean(
      std.host === sourceHost &&
      sourceHost.isConnected &&
      std.store.doc.id === source.sourceExternalId &&
      (std.getOptional(DocModeProvider)?.getEditorMode() ?? "page") ===
        openingMode &&
      currentServer &&
      JSON.stringify([
        currentServer.id,
        currentServer.baseUrl,
        currentServer.account$.value?.id,
        std.workspace.id,
      ]) === openingOwnerIdentity,
    );
  };
  const metadata = framework.get(DocumentMetadataCacheService);
  const loadedModel = metadata.getModel(source.sourceExternalId);
  let sourceDocumentId =
    loadedModel?.metadata.docId ??
    metadata.getIndexRowByExternalId(source.sourceExternalId)?.docId;
  try {
    if (!isCurrent()) return false;
    if (loadedModel && loadedModel.metadata.workspaceId !== sourceWorkspaceId)
      throw new Error("Source metadata scope changed");
    // Yjs delivery can precede metadata hydration for a newly-created document.
    // Keep the frozen editor snapshot; await its existing canonical ID owner.
    if (!sourceDocumentId) {
      const hydrated = await metadata.hydrateModel(source.sourceExternalId);
      if (
        !isCurrent() ||
        hydrated.metadata.workspaceId !== sourceWorkspaceId ||
        !hydrated.metadata.docId
      )
        throw new Error("Source metadata unavailable");
      sourceDocumentId = hydrated.metadata.docId;
    }
  } catch {
    notify.error({ title: I18n["com.myoxus.database.embed.unavailable"]() });
    return false;
  }
  const guard = framework.get(GuardService);
  try {
    if (!isCurrent()) return false;
    const [read, copy] = await Promise.all([
      guard.can("Doc_Read", source.sourceExternalId),
      guard.can("Doc_Copy", source.sourceExternalId),
    ]);
    const currentMetadata = metadata.getModel(
      source.sourceExternalId,
    )?.metadata;
    const currentIndexedId = metadata.getIndexRowByExternalId(
      source.sourceExternalId,
    )?.docId;
    if (
      !read ||
      !copy ||
      !isCurrent() ||
      (currentIndexedId && currentIndexedId !== sourceDocumentId) ||
      (currentMetadata &&
        (currentMetadata.workspaceId !== sourceWorkspaceId ||
          currentMetadata.docId !== sourceDocumentId))
    )
      throw new Error("Source unavailable");
    const insertReference = createTaskReferenceInserter(
      framework,
      std,
      openingOwnerIdentity,
    );
    const closed = () => {
      if (mode === "insert") insertReference.releaseConfirmed();
      onClose?.();
    };
    if (mode === "insert") {
      framework.get(WorkspaceDialogService).open(
        "task-reference-insert",
        {
          openingOwnerIdentity,
          source: {
            sourceDocumentId,
            sourceExternalId: source.sourceExternalId,
            blockId: source.blockId,
            selectionAnchor: source.selectionAnchor,
          },
          returnFocusRef,
          onInsertReference: insertReference,
        },
        closed,
      );
      return true;
    }
    const backlinks = framework.get(DocLinksService).backlinks;
    let refreshed = false;
    framework.get(WorkspaceDialogService).open(
      "task-capture",
      {
        ...source,
        sourceDocumentId,
        openingOwnerIdentity,
        onInsertReference: insertReference,
        onCaptureReleased: (requestId) =>
          insertReference.releaseConfirmed(requestId),
        onConfirmed: () => {
          const activeServer = servers.server;
          if (
            !activeServer ||
            JSON.stringify([
              activeServer.id,
              activeServer.baseUrl,
              activeServer.account$.value?.id,
              std.workspace.id,
            ]) !== openingOwnerIdentity
          )
            return;
          if (
            refreshed ||
            !std.host.isConnected ||
            std.workspace.id !== sourceWorkspaceId ||
            std.store.doc.id !== source.sourceExternalId
          )
            return;
          const currentId =
            metadata.getModel(source.sourceExternalId)?.metadata.docId ??
            metadata.getIndexRowByExternalId(source.sourceExternalId)?.docId;
          if (currentId !== sourceDocumentId) return;
          refreshed = true;
          backlinks.revalidateFromCloud();
        },
        returnFocusRef,
      },
      closed,
    );
    return true;
  } catch {
    notify.error({ title: I18n["com.myoxus.database.row_detail.forbidden"]() });
    return false;
  }
}

export function createTaskToolbarActions(framework?: FrameworkProvider) {
  const captureAction = {
    id: "capture-as-task",
    label: editorMessage(
      "com.myoxus.database.tasks.capture",
      "Capture as Task",
    ),
    icon: "CopyIcon",
    when: (ctx) => {
      if (!framework || ctx.flags.isHovering()) return false;
      const selectedModels = taskCaptureModels(ctx.std);
      return Boolean(snapshotTaskCaptureSelection(ctx.std, selectedModels));
    },
    run: async (ctx) => {
      if (!framework) return;
      const selectedModels = taskCaptureModels(ctx.std);
      const source = snapshotTaskCaptureSelection(ctx.std, selectedModels);
      if (!source) return;
      ctx.hide();
      try {
        const opened = await openTaskCapture(
          framework,
          ctx.std,
          selectedModels,
          () => ctx.show(),
        );
        if (!opened) ctx.show();
      } catch {
        // Framework/metadata lookup may fail before the guarded opening path.
        ctx.show();
        notify.error({
          title: I18n["com.myoxus.database.embed.unavailable"](),
        });
      }
    },
  } satisfies ToolbarAction;
  const insertExistingAction: ToolbarAction = {
    ...captureAction,
    id: "insert-existing-task",
    label: editorMessage(
      "com.myoxus.database.tasks.insert-existing",
      "Insert existing Task",
    ),
    when: (ctx) =>
      !ctx.readonly &&
      Boolean(
        typeof captureAction.when === "function" && captureAction.when(ctx),
      ),
    run: async (ctx) => {
      if (!framework) return;
      const selectedModels = taskCaptureModels(ctx.std);
      if (!snapshotTaskCaptureSelection(ctx.std, selectedModels)) return;
      ctx.hide();
      try {
        if (
          !(await openTaskCapture(
            framework,
            ctx.std,
            selectedModels,
            () => ctx.show(),
            "insert",
          ))
        )
          ctx.show();
      } catch {
        ctx.show();
        notify.error({
          title: I18n["com.myoxus.database.embed.unavailable"](),
        });
      }
    },
  };
  return { captureAction, insertExistingAction };
}
