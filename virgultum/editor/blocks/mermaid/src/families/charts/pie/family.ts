// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidDiagramType } from "../../../engine/diagram-types.js";
import type { MermaidPieModel } from "../../../engine/charts/pie/model.js";
import { parseMermaidPieSourceResult } from "../../../engine/charts/pie/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import type {
  MermaidFamilyDiagnostic,
  MermaidFamilyModule,
} from "../../contracts.js";
import { mermaidPieEmbeddedActions } from "./edgeless-actions.js";

export type MermaidPieFrameContext = {
  readonly readPieModel?: () => MermaidPieModel | null;
};

function unsupportedDiagnostic(diagramType: MermaidDiagramType) {
  return {
    code: "pie.unsupported-diagram-type",
    message: `Pie owner cannot parse ${diagramType}.`,
    severity: "error" as const,
  };
}

export const mermaidPieFamily: MermaidFamilyModule<
  MermaidPieModel,
  MermaidPieModel,
  MermaidPieFrameContext
> = {
  applyVisualToSource: (_visualModel, previousSource) => ({
    diagnostics: [
      {
        code: "pie.command-required",
        message: "Pie source changes require a typed Pie command.",
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  commands: [
    {
      id: "pie.slice.add",
      label: mermaidMessages.structuredAddEntry(),
      role: "create",
    },
    {
      id: "pie.slice.rename",
      label: mermaidMessages.selectedNodeLabel(),
      role: "edit",
    },
    {
      id: "pie.slice.value",
      label: mermaidMessages.selectedPieValue(),
      role: "edit",
    },
    {
      id: "pie.slice.reorder",
      label: mermaidMessages.visualMoveDown(),
      role: "reorder",
    },
    {
      id: "pie.slice.delete",
      label: mermaidMessages.visualDelete(),
      role: "delete",
    },
    {
      id: "pie.data.toggle",
      label: mermaidMessages.pieData(),
      role: "edit",
    },
    {
      id: "pie.appearance.open",
      label: mermaidMessages.visualAppearance(),
      role: "edit",
    },
    {
      id: "pie.comments.open",
      label: mermaidMessages.visualComments(),
      role: "edit",
    },
    {
      id: "pie.more.open",
      label: mermaidMessages.visualMoreActions(),
      role: "edit",
    },
  ],
  diagramTypes: ["pie"],
  id: "pie",
  inspector: [],
  materializeFrame: () => undefined,
  parseSource: (source, diagramType) => {
    if (diagramType !== "pie") {
      return {
        diagnostics: [unsupportedDiagnostic(diagramType)],
        diagramType: "pie",
        model: null,
        source,
      };
    }
    const parsed = parseMermaidPieSourceResult(source);
    const diagnostics: MermaidFamilyDiagnostic[] = parsed.model
      ? parsed.model.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          severity: diagnostic.severity,
        }))
      : [
          {
            code: parsed.diagnostic.code,
            message: parsed.diagnostic.message,
            severity: parsed.diagnostic.severity,
          },
        ];
    return {
      diagnostics,
      diagramType,
      model: parsed.model,
      source,
    };
  },
  readFrame: (context) => context.readPieModel?.() ?? null,
  toolbar: mermaidPieEmbeddedActions,
  toVisualModel: (parseResult) =>
    parseResult.model
      ? {
          diagnostics: parseResult.diagnostics,
          kind: "editable",
          visualModel: parseResult.model,
        }
      : {
          diagnostics: parseResult.diagnostics,
          kind: "source-only",
          reason: "Pie source has no executable Pie model.",
        },
};
