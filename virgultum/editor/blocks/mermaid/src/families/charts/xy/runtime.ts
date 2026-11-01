// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../../i18n.js";
import { parseMermaidXySourceResult } from "../../../engine/charts/xy/parser.js";
import type { MermaidXyModel } from "../../../engine/charts/xy/model.js";
import type {
  MermaidFamilyRuntimeResolution,
  MermaidFamilyStructuredResolutionContext,
} from "../../runtime/contracts.js";
import { defineMermaidFamilyRuntime } from "../../runtime/factory.js";
import { mermaidXyDiagramTitle } from "./diagram-title.js";
import { localizedXyDiagnostic, mermaidXyFamily } from "./family.js";
import { xyEditorCapabilities } from "./host-adapter.js";

function resolveXyRuntime(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "xychart") return null;
  const previous =
    context.previousStructuredModel &&
    typeof context.previousStructuredModel === "object" &&
    "diagramType" in context.previousStructuredModel &&
    context.previousStructuredModel.diagramType === "xychart"
      ? (context.previousStructuredModel as MermaidXyModel)
      : undefined;
  const sourceResult = parseMermaidXySourceResult(context.source, previous);
  const parsed = sourceResult.model
    ? {
        diagnostics: sourceResult.model.diagnostics.map(localizedXyDiagnostic),
        model: sourceResult.model,
      }
    : {
        diagnostics: [localizedXyDiagnostic(sourceResult.diagnostic)],
        model: null,
      };
  if (!parsed.model)
    return {
      diagnostics: parsed.diagnostics,
      diagramType: "xychart",
      kind: "source-first",
      reason: parsed.diagnostics[0]?.message ?? mermaidMessages.previewEmpty(),
      runtime: context.runtime,
      source: context.source,
    };
  return {
    capabilities: xyEditorCapabilities(context.source, parsed.model),
    diagnostics: parsed.diagnostics,
    diagramType: "xychart",
    kind: "resolved",
    runtime: context.runtime,
    source: context.source,
    structuredModel: parsed.model,
  };
}

export const mermaidXyRuntime = defineMermaidFamilyRuntime({
  ...mermaidXyFamily,
  applyGfxVisualToSource: (previousSource) => ({
    diagnostics: [
      {
        code: "xy.gfx-forbidden",
        message: mermaidMessages.xyCommandInvalid(),
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  diagramTitle: mermaidXyDiagramTitle,
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveXyRuntime,
  sourceDiagnostics: (source, diagramType) =>
    mermaidXyFamily.parseSource(source, diagramType).diagnostics,
});
