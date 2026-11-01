// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidDiagramType } from "../../../engine/diagram-types.js";
import type { MermaidQuadrantModel } from "../../../engine/charts/quadrant/model.js";
import type { MermaidQuadrantDiagnostic } from "../../../engine/charts/quadrant/diagnostics.js";
import { parseMermaidQuadrantSourceResult } from "../../../engine/charts/quadrant/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import type {
  MermaidFamilyDiagnostic,
  MermaidFamilyModule,
} from "../../contracts.js";
import { mermaidQuadrantEmbeddedActions } from "./edgeless-actions.js";

export type MermaidQuadrantFrameContext = {
  readQuadrantModel?: () => MermaidQuadrantModel | null;
};

function unsupportedDiagnostic(
  _diagramType: MermaidDiagramType,
): MermaidFamilyDiagnostic {
  return {
    code: "quadrant.unsupported-diagram-type",
    message: mermaidMessages.quadrantDiagnosticUnsupported(1),
    severity: "error",
  };
}

export function localizedQuadrantDiagnostic(
  diagnostic: MermaidQuadrantDiagnostic,
) {
  const line = diagnostic.range.startLine + 1;
  const message =
    diagnostic.code === "invalid-axis"
      ? mermaidMessages.quadrantDiagnosticInvalidAxis(line)
      : diagnostic.code === "invalid-class"
        ? mermaidMessages.quadrantDiagnosticInvalidClass(line)
        : diagnostic.code === "invalid-config"
          ? mermaidMessages.quadrantDiagnosticInvalidConfig(line)
          : diagnostic.code === "invalid-coordinate"
            ? mermaidMessages.quadrantDiagnosticInvalidCoordinate(line)
            : diagnostic.code === "invalid-point"
              ? mermaidMessages.quadrantDiagnosticInvalidPoint(line)
              : diagnostic.code === "invalid-style"
                ? mermaidMessages.quadrantDiagnosticInvalidStyle(line)
                : diagnostic.code === "unsupported-statement"
                  ? mermaidMessages.quadrantDiagnosticUnsupported(line)
                  : mermaidMessages.quadrantDiagnosticAmbiguous(line);
  return { ...diagnostic, message };
}

export const mermaidQuadrantFamily: MermaidFamilyModule<
  MermaidQuadrantModel,
  MermaidQuadrantModel,
  MermaidQuadrantFrameContext
> = {
  applyVisualToSource: (_visualModel, previousSource) => ({
    diagnostics: [
      {
        code: "quadrant.command-required",
        message: mermaidMessages.quadrantDiagnosticCommandRequired(),
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  commands: [
    {
      id: "quadrant.point.add",
      label: mermaidMessages.chartAddPoint(),
      role: "create",
    },
    {
      id: "quadrant.point.rename",
      label: mermaidMessages.quadrantPointLabel(),
      role: "edit",
    },
    {
      id: "quadrant.point.move",
      label: mermaidMessages.quadrantCoordinates(),
      role: "edit",
    },
    {
      id: "quadrant.point.reorder",
      label: mermaidMessages.visualMoveDown(),
      role: "reorder",
    },
    {
      id: "quadrant.point.delete",
      label: mermaidMessages.visualDelete(),
      role: "delete",
    },
    {
      id: "quadrant.data.toggle",
      label: mermaidMessages.pieData(),
      role: "edit",
    },
    {
      id: "quadrant.comments.open",
      label: mermaidMessages.visualComments(),
      role: "edit",
    },
    {
      id: "quadrant.appearance.open",
      label: mermaidMessages.visualAppearance(),
      role: "edit",
    },
    {
      id: "quadrant.more.open",
      label: mermaidMessages.visualMoreActions(),
      role: "edit",
    },
  ],
  diagramTypes: ["quadrantChart"],
  id: "quadrant",
  inspector: [],
  materializeFrame: () => undefined,
  parseSource: (source, diagramType) => {
    if (diagramType !== "quadrantChart") {
      return {
        diagnostics: [unsupportedDiagnostic(diagramType)],
        diagramType: "quadrantChart",
        model: null,
        source,
      };
    }
    const parsed = parseMermaidQuadrantSourceResult(source);
    const diagnostics: MermaidFamilyDiagnostic[] = parsed.model
      ? parsed.model.diagnostics
          .map(localizedQuadrantDiagnostic)
          .map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            severity: diagnostic.severity,
          }))
      : [
          {
            code: parsed.diagnostic.code,
            message: localizedQuadrantDiagnostic(parsed.diagnostic).message,
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
  readFrame: (context) => context.readQuadrantModel?.() ?? null,
  toolbar: mermaidQuadrantEmbeddedActions,
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
          reason:
            parseResult.diagnostics[0]?.message ??
            mermaidMessages.previewEmpty(),
        },
};
