// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidDiagramType } from "../../../engine/diagram-types.js";
import type { MermaidXyModel } from "../../../engine/charts/xy/model.js";
import { parseMermaidXySourceResult } from "../../../engine/charts/xy/parser.js";
import type { MermaidXyDiagnostic } from "../../../engine/charts/xy/diagnostics.js";
import { mermaidMessages } from "../../../i18n.js";
import type {
  MermaidFamilyDiagnostic,
  MermaidFamilyModule,
} from "../../contracts.js";
import { mermaidXyEmbeddedActions } from "./edgeless-actions.js";

export type MermaidXyFrameContext = {
  readXyModel?: () => MermaidXyModel | null;
};

function unsupportedDiagnostic(
  _diagramType: MermaidDiagramType,
): MermaidFamilyDiagnostic {
  return {
    code: "xy.unsupported-diagram-type",
    message: mermaidMessages.xyCommandInvalid(),
    severity: "error",
  };
}

export function localizedXyDiagnostic(diagnostic: MermaidXyDiagnostic) {
  const line = diagnostic.range.startLine + 1;
  const message =
    diagnostic.code === "invalid-config"
      ? mermaidMessages.xyDiagnosticInvalidConfig(line)
      : diagnostic.code === "invalid-number"
        ? mermaidMessages.xyDiagnosticInvalidNumber(line)
        : diagnostic.code === "invalid-range"
          ? mermaidMessages.xyDiagnosticInvalidRange(line)
          : diagnostic.code === "length-mismatch"
            ? mermaidMessages.xyDiagnosticLengthMismatch(line)
            : diagnostic.code === "unsupported-statement"
              ? mermaidMessages.xyDiagnosticUnsupported(line)
              : diagnostic.code === "ambiguous-source"
                ? mermaidMessages.xyDiagnosticAmbiguous(line)
                : mermaidMessages.xyDiagnosticInvalidStatement(line);
  return { ...diagnostic, message };
}

export const mermaidXyFamily: MermaidFamilyModule<
  MermaidXyModel,
  MermaidXyModel,
  MermaidXyFrameContext
> = {
  applyVisualToSource: (_visualModel, previousSource) => ({
    diagnostics: [
      {
        code: "xy.command-required",
        message: mermaidMessages.xyCommandInvalid(),
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  commands: [
    {
      id: "xy.plot.add",
      label: mermaidMessages.xyAddPlot(),
      role: "create",
    },
    {
      id: "xy.category.add",
      label: mermaidMessages.chartAddCategory(),
      role: "create",
    },
    {
      id: "xy.point.add",
      label: mermaidMessages.chartAddPoint(),
      role: "create",
    },
    { id: "xy.data.toggle", label: mermaidMessages.pieData(), role: "edit" },
    { id: "xy.axes.open", label: mermaidMessages.xyAxes(), role: "edit" },
    {
      id: "xy.comments.open",
      label: mermaidMessages.visualComments(),
      role: "edit",
    },
    {
      id: "xy.appearance.open",
      label: mermaidMessages.visualAppearance(),
      role: "edit",
    },
    {
      id: "xy.more.open",
      label: mermaidMessages.visualMoreActions(),
      role: "edit",
    },
  ],
  diagramTypes: ["xychart"],
  id: "xy",
  inspector: [],
  materializeFrame: () => undefined,
  parseSource: (source, diagramType) => {
    if (diagramType !== "xychart")
      return {
        diagnostics: [unsupportedDiagnostic(diagramType)],
        diagramType: "xychart",
        model: null,
        source,
      };
    const parsed = parseMermaidXySourceResult(source);
    const diagnostics: MermaidFamilyDiagnostic[] = parsed.model
      ? parsed.model.diagnostics
          .map(localizedXyDiagnostic)
          .map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            severity: diagnostic.severity,
          }))
      : [
          {
            code: parsed.diagnostic.code,
            message: localizedXyDiagnostic(parsed.diagnostic).message,
            severity: parsed.diagnostic.severity,
          },
        ];
    return { diagnostics, diagramType, model: parsed.model, source };
  },
  readFrame: (context) => context.readXyModel?.() ?? null,
  toolbar: mermaidXyEmbeddedActions,
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
