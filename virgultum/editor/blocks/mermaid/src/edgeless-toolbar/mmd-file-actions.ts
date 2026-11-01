// SPDX-License-Identifier: AGPL-3.0-or-later

import { ImportIcon } from "@myoxus/icons/lit";
import { menu, type MenuConfig } from "@virgultum/components/context-menu";
import { NotificationProvider } from "@virgultum/shared/services";
import type { ToolbarAction, ToolbarContext } from "@virgultum/shared/services";
import type { BlockComponent } from "@virgultum/std";
import { downloadBlob, openSingleFileWith } from "@virgultum/shared/utils";
import type { MermaidBlockModel } from "@virgultum/model";

import { insertMermaidEdgelessDiagramCommand } from "../commands.js";
import { resolveMermaidSourceLifecycle } from "../families/runtime/source-lifecycle.js";
import { mermaidMessages } from "../i18n.js";
import { normalizeMermaidExportFileName } from "../mermaid-export-file.js";
import { prepareMermaidFamilySource } from "../families/runtime/registry.js";
import { getMermaidBlockSource, getMermaidBlockTitle } from "../utils.js";
import { resolveMermaidEdgelessExportOwner } from "./selection-context.js";

function importFailureMessage(source: string) {
  const lifecycle = resolveMermaidSourceLifecycle(source);
  return (
    lifecycle.reason ??
    ("diagnostics" in lifecycle.resolution
      ? lifecycle.resolution.diagnostics[0]?.message
      : undefined) ??
    mermaidMessages.mmdImportInvalid()
  );
}

export async function importMermaidMmdFile(edgeless: BlockComponent) {
  if (edgeless.store.readonly) return;
  const file = await openSingleFileWith("Mermaid");
  if (!file) return;

  let source: string;
  try {
    source = await file.text();
  } catch {
    edgeless.std.getOptional(NotificationProvider)?.notify({
      accent: "error",
      message: mermaidMessages.mmdImportReadFailed(),
      title: mermaidMessages.mmdImportFailed(),
    });
    return;
  }

  await prepareMermaidFamilySource(source);
  if (edgeless.store.readonly) return;
  const lifecycle = resolveMermaidSourceLifecycle(source);
  if (lifecycle.resolution.kind !== "resolved") {
    edgeless.std.getOptional(NotificationProvider)?.notify({
      accent: "error",
      message: importFailureMessage(source),
      title: mermaidMessages.mmdImportFailed(),
    });
    return;
  }

  const title = normalizeMermaidExportFileName(
    file.name.replace(/\.mmd$/i, ""),
  );
  const [, result] = edgeless.std.command.exec(
    insertMermaidEdgelessDiagramCommand,
    { source, title },
  );
  if (!result?.insertedMermaidBlockId) {
    edgeless.std.getOptional(NotificationProvider)?.notify({
      accent: "error",
      message: mermaidMessages.mmdImportInvalid(),
      title: mermaidMessages.mmdImportFailed(),
    });
  }
}

export function createMermaidMmdImportMenuItem(
  edgeless: BlockComponent,
): MenuConfig {
  if (edgeless.store.readonly) return () => undefined;
  return menu.action({
    name: mermaidMessages.mmdImport(),
    prefix: ImportIcon({ width: "20px", height: "20px" }),
    select: () => void importMermaidMmdFile(edgeless),
    testId: "myoxus-mermaid-edgeless-import-mmd",
  });
}

export function exportMermaidMmdOwner(owner: MermaidBlockModel) {
  // Export owns the persisted source, including trivia and EOL. Import
  // normalization is lossy and must never run on this boundary.
  const source = getMermaidBlockSource(owner.props);
  const basename = normalizeMermaidExportFileName(
    getMermaidBlockTitle(owner.props).replace(/\.mmd$/i, ""),
  );
  downloadBlob(
    new Blob([source], { type: "text/plain;charset=utf-8" }),
    `${basename}.mmd`,
  );
}

export const mermaidMmdExportAction: ToolbarAction = {
  id: "mermaid-owner.export-mmd",
  icon: "DownloadIcon",
  label: mermaidMessages.mmdExport(),
  when: (context) => Boolean(resolveMermaidEdgelessExportOwner(context)),
  run(context: ToolbarContext) {
    const owner = resolveMermaidEdgelessExportOwner(context);
    if (!owner) return;
    exportMermaidMmdOwner(owner);
  },
};
