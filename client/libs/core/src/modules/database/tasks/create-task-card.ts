// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import type { BlockModel, Store } from "@virgultum/editor/store";
import type { SlashMenuContext } from "@virgultum/editor/widgets/slash-menu";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { createTaskReferenceInserter } from "./task-reference-insertion";

export type TaskCardCreationTarget =
  | SlashMenuContext
  | {
      store: Store;
      model: BlockModel;
      anchor: HTMLElement;
      isAttached: () => boolean;
    };

/** Freeze the source before metadata hydration. SQL capture receipts and the
 * existing reference inserter own retry identity; this opener never writes data.
 */
export async function openTaskCardCreation(
  framework: FrameworkProvider,
  target: TaskCardCreationTarget,
) {
  const isStdTarget = "std" in target;
  const std = isStdTarget ? target.std : undefined;
  const store = isStdTarget ? target.std.store : target.store;
  const workspace = isStdTarget ? target.std.workspace : store.workspace;
  const { model } = target;
  const servers = framework.get(WorkspaceServerService);
  const server = servers.server;
  if (!server?.account$.value || store.readonly) return;
  const sourceExternalId = store.doc.id;
  const mode = std
    ? (std.getOptional(DocModeProvider)?.getEditorMode() ?? "page")
    : "page";
  if (mode !== "page") return;
  const owner = JSON.stringify([
    server.id,
    server.baseUrl,
    server.account$.value.id,
    workspace.id,
  ]);
  const anchor = isStdTarget
    ? target.std.view.getBlock(model.id)
    : target.anchor;
  const isAttached = isStdTarget
    ? () => Boolean(target.std.host.isConnected && anchor?.isConnected)
    : () => Boolean(target.isAttached() && anchor?.isConnected);
  const isCurrent = () => {
    const current = servers.server;
    return Boolean(
      current &&
      isAttached() &&
      store.doc.id === sourceExternalId &&
      store.getBlock(model.id)?.model === model &&
      (std
        ? (std.getOptional(DocModeProvider)?.getEditorMode() ?? "page")
        : "page") === mode &&
      JSON.stringify([
        current.id,
        current.baseUrl,
        current.account$.value?.id,
        workspace.id,
      ]) === owner,
    );
  };
  try {
    const metadata = framework.get(DocumentMetadataCacheService);
    const sourceDocumentId =
      metadata.getModel(sourceExternalId)?.metadata.docId ??
      metadata.getIndexRowByExternalId(sourceExternalId)?.docId ??
      (await metadata.hydrateModel(sourceExternalId)).metadata.docId;
    if (
      !sourceDocumentId ||
      !isCurrent() ||
      !(await framework
        .get(GuardService)
        .can("Doc_Update", sourceExternalId)) ||
      !isCurrent()
    )
      return;
    const insert = createTaskReferenceInserter(
      framework,
      isStdTarget ? target.std : { store, isAttached: target.isAttached },
      owner,
    );
    framework.get(WorkspaceDialogService).open("task-card-create", {
      openingOwnerIdentity: owner,
      source: { sourceDocumentId, sourceExternalId, blockId: model.id },
      anchor: anchor!,
      isCurrent,
      onInsertReference: insert,
      onInserted: (requestId) => insert.releaseConfirmed(requestId),
    });
  } catch {
    notify.error({ title: I18n["com.myoxus.database.embed.unavailable"]() });
  }
}
