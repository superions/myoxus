// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidPieDiagramTitle } from "./diagram-title.js";
import { mermaidPieFamily } from "./family.js";
import { pieEditorCapabilities } from "./host-adapter.js";
import { defineMermaidFamilyRuntime } from "../../runtime/factory.js";
import type {
  MermaidFamilyRuntimeResolution,
  MermaidFamilyStructuredResolutionContext,
} from "../../runtime/contracts.js";

function resolvePieRuntime(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "pie") return null;
  const parsed = mermaidPieFamily.parseSource(context.source, "pie");
  if (!parsed.model) {
    return {
      diagnostics: parsed.diagnostics,
      diagramType: "pie",
      kind: "source-first",
      reason:
        parsed.diagnostics[0]?.message ?? "Pie source has no executable model.",
      runtime: context.runtime,
      source: context.source,
    };
  }
  return {
    capabilities: pieEditorCapabilities(context.source, parsed.model),
    diagnostics: parsed.diagnostics,
    diagramType: "pie",
    kind: "resolved",
    runtime: context.runtime,
    source: context.source,
  };
}

export const mermaidPieRuntime = defineMermaidFamilyRuntime({
  ...mermaidPieFamily,
  applyGfxVisualToSource: (previousSource) => ({
    diagnostics: [
      {
        code: "pie.gfx-forbidden",
        message: "Pie has no GFX source-application path.",
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  diagramTitle: mermaidPieDiagramTitle,
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolvePieRuntime,
  sourceDiagnostics: (source, diagramType) =>
    mermaidPieFamily.parseSource(source, diagramType).diagnostics,
});
