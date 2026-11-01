// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyModel } from "../../../engine/charts/sankey/model.js";
import { parseSankeySource } from "../../../engine/charts/sankey/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import type { MermaidFamilyModule } from "../../contracts.js";
import { mermaidSankeyEmbeddedActions } from "./edgeless-actions.js";

export function sankeyFamilyDiagnostics(model: SankeyModel) {
  return model.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: "error" as const,
    message:
      diagnostic.code === "conflict"
        ? mermaidMessages.chartSourceChanged()
        : mermaidMessages.errorLine({ line: diagnostic.line }),
  }));
}

/** Source commands, not replacement graph serialization, own all Sankey edits. */
export const mermaidSankeyFamily: MermaidFamilyModule<
  SankeyModel,
  SankeyModel,
  { readonly readSankeyModel?: () => SankeyModel | null }
> = {
  id: "sankey",
  diagramTypes: ["sankey"],
  commands: mermaidSankeyEmbeddedActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId === "sankey.link.add" ? "create" : "edit",
  })),
  toolbar: mermaidSankeyEmbeddedActions,
  inspector: [],
  materializeFrame: () => undefined,
  readFrame: (context) => context.readSankeyModel?.() ?? null,
  parseSource: (source, diagramType) => {
    const model = diagramType === "sankey" ? parseSankeySource(source) : null;
    return {
      source,
      diagramType: "sankey",
      model,
      diagnostics: model
        ? sankeyFamilyDiagnostics(model)
        : [
            {
              code: "sankey.header",
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
        code: "sankey.command-required",
        severity: "error",
        message: mermaidMessages.visualMutationOwnerUnavailable("Sankey"),
      },
    ],
  }),
};
