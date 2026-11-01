// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidRadarModel } from "../../../engine/charts/radar/model.js";
import { parseMermaidRadarSourceResult } from "../../../engine/charts/radar/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import type {
  MermaidFamilyRuntimeResolution,
  MermaidFamilyStructuredResolutionContext,
} from "../../runtime/contracts.js";
import { defineMermaidFamilyRuntime } from "../../runtime/factory.js";
import { mermaidRadarDiagramTitle } from "./diagram-title.js";
import { localizedRadarDiagnostic, mermaidRadarFamily } from "./family.js";
import { radarEditorCapabilities } from "./host-adapter.js";

function resolveRadarRuntime(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "radar") return null;
  const previous =
    context.previousStructuredModel &&
    typeof context.previousStructuredModel === "object" &&
    "diagramType" in context.previousStructuredModel &&
    context.previousStructuredModel.diagramType === "radar"
      ? (context.previousStructuredModel as MermaidRadarModel)
      : undefined;
  const parsed = parseMermaidRadarSourceResult(context.source, previous);
  if (!parsed.model) {
    const diagnostic = localizedRadarDiagnostic(parsed.diagnostic);
    return {
      diagnostics: [diagnostic],
      diagramType: "radar",
      kind: "source-first",
      reason: diagnostic.message,
      runtime: context.runtime,
      source: context.source,
    };
  }
  const diagnostics = parsed.model.diagnostics.map(localizedRadarDiagnostic);
  return {
    capabilities: radarEditorCapabilities(context.source, parsed.model),
    diagnostics,
    diagramType: "radar",
    kind: "resolved",
    runtime: context.runtime,
    source: context.source,
    structuredModel: parsed.model,
  };
}

export const mermaidRadarRuntime = defineMermaidFamilyRuntime({
  ...mermaidRadarFamily,
  applyGfxVisualToSource: (previousSource) => ({
    diagnostics: [
      {
        code: "radar.gfx-forbidden",
        message: mermaidMessages.radarCommandInvalid(),
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  diagramTitle: mermaidRadarDiagramTitle,
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveRadarRuntime,
  sourceDiagnostics: (source, diagramType) =>
    mermaidRadarFamily.parseSource(source, diagramType).diagnostics,
});
