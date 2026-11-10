// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import type { SlashMenuContext } from "@virgultum/editor/widgets/slash-menu";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { createTaskReferenceInserter } from "./task-reference-insertion";

/** Freeze the source before metadata hydration. SQL capture receipts and the
 * existing reference inserter own retry identity; this opener never writes data.
 */
export async function openTaskCardCreation(
  framework: FrameworkProvider,
  { std, model }: SlashMenuContext,
) {
  const servers = framework.get(WorkspaceServerService);
  const server = servers.server;
  if (!server?.account$.value || std.store.readonly) return;
  const sourceExternalId = std.store.doc.id;
  const mode = std.getOptional(DocModeProvider)?.getEditorMode() ?? "page";
  if (mode !== "page") return;
  const owner = JSON.stringify([
    server.id,
    server.baseUrl,
    server.account$.value.id,
    std.workspace.id,
  ]);
  const anchor = std.view.getBlock(model.id);
  const isCurrent = () => {
    const current = servers.server;
    return Boolean(
      current &&
      std.host.isConnected &&
      anchor?.isConnected &&
      std.store.doc.id === sourceExternalId &&
      std.store.getBlock(model.id)?.model === model &&
      (std.getOptional(DocModeProvider)?.getEditorMode() ?? "page") === mode &&
      JSON.stringify([
        current.id,
        current.baseUrl,
        current.account$.value?.id,
        std.workspace.id,
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
    const insert = createTaskReferenceInserter(framework, std, owner);
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
