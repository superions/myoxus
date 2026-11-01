// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidFamilyRuntimeResolution,
  MermaidFamilyStructuredResolutionContext,
} from "../../runtime/contracts.js";
import { defineMermaidFamilyRuntime } from "../../runtime/factory.js";
import { mermaidMessages } from "../../../i18n.js";
import { mermaidQuadrantDiagramTitle } from "./diagram-title.js";
import { mermaidQuadrantFamily } from "./family.js";
import { quadrantEditorCapabilities } from "./host-adapter.js";

function resolveQuadrantRuntime(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "quadrantChart") return null;
  const parsed = mermaidQuadrantFamily.parseSource(
    context.source,
    "quadrantChart",
  );
  if (!parsed.model) {
    return {
      diagnostics: parsed.diagnostics,
      diagramType: "quadrantChart",
      kind: "source-first",
      reason: parsed.diagnostics[0]?.message ?? mermaidMessages.previewEmpty(),
      runtime: context.runtime,
      source: context.source,
    };
  }
  return {
    capabilities: quadrantEditorCapabilities(context.source, parsed.model),
    diagnostics: parsed.diagnostics,
    diagramType: "quadrantChart",
    kind: "resolved",
    runtime: context.runtime,
    source: context.source,
  };
}

export const mermaidQuadrantRuntime = defineMermaidFamilyRuntime({
  ...mermaidQuadrantFamily,
  applyGfxVisualToSource: (previousSource) => ({
    diagnostics: [
      {
        code: "quadrant.gfx-forbidden",
        message: mermaidMessages.quadrantDiagnosticGfxForbidden(),
        severity: "error",
      },
    ],
    source: previousSource,
  }),
  diagramTitle: mermaidQuadrantDiagramTitle,
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveQuadrantRuntime,
  sourceDiagnostics: (source, diagramType) =>
    mermaidQuadrantFamily.parseSource(source, diagramType).diagnostics,
});
