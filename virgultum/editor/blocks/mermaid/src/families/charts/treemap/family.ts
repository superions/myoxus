// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapModel } from "../../../engine/charts/treemap/model.js";
import { parseTreemapSource } from "../../../engine/charts/treemap/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyModule } from "../../contracts.js";
import { mermaidTreemapEmbeddedActions } from "./edgeless-actions.js";

export function treemapFamilyDiagnostics(model: TreemapModel) {
  return model.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: "error" as const,
    message:
      diagnostic.code === "conflict"
        ? mermaidMessages.chartSourceChanged()
        : mermaidMessages.errorLine({ line: diagnostic.range.line }),
  }));
}

/** Treemap's persisted authority is source; visual models are never serialized. */
export const mermaidTreemapFamily: MermaidFamilyModule<
  TreemapModel,
  TreemapModel,
  { readonly readTreemapModel?: () => TreemapModel | null }
> = {
  id: "treemap",
  diagramTypes: ["treemap"],
  commands: mermaidTreemapEmbeddedActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId.endsWith(".add") ? "create" : "edit",
  })),
  toolbar: mermaidTreemapEmbeddedActions,
  inspector: [],
  materializeFrame: () => undefined,
  readFrame: (context) => context.readTreemapModel?.() ?? null,
  parseSource: (source, diagramType) => {
    const model = diagramType === "treemap" ? parseTreemapSource(source) : null;
    return {
      source,
      diagramType: "treemap",
      model,
      diagnostics: model
        ? treemapFamilyDiagnostics(model)
        : [
            {
              code: "treemap.header",
              severity: "error",
              message: mermaidMessages.mmdImportInvalid(),
            },
          ],
    };
  },
  toVisualModel: (parsed) =>
    parsed.model
      ? {
          kind: "editable",
          visualModel: parsed.model,
          diagnostics: parsed.diagnostics,
        }
      : {
          kind: "source-only",
          reason: mermaidMessages.mmdImportInvalid(),
          diagnostics: parsed.diagnostics,
        },
  applyVisualToSource: (_model, source) => ({
    source,
    diagnostics: [
      {
        code: "treemap.command-required",
        severity: "error",
        message: mermaidMessages.visualMutationOwnerUnavailable("Treemap"),
      },
    ],
  }),
};
