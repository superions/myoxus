// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapModel } from "../../../engine/charts/treemap/model.js";
import { parseTreemapSource } from "../../../engine/charts/treemap/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import { defineMermaidFamilyRuntime } from "../../runtime/factory.js";
import { mermaidTreemapDiagramTitle } from "./diagram-title.js";
import { mermaidTreemapFamily, treemapFamilyDiagnostics } from "./family.js";
import { treemapEditorCapabilities } from "./host-adapter.js";

export const mermaidTreemapRuntime = defineMermaidFamilyRuntime({
  ...mermaidTreemapFamily,
  diagramTitle: mermaidTreemapDiagramTitle,
  applyGfxVisualToSource: (source) => ({
    source,
    diagnostics: [
      {
        code: "treemap.command-required",
        severity: "error",
        message: mermaidMessages.visualMutationOwnerUnavailable("Treemap"),
      },
    ],
  }),
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  sourceDiagnostics: (source, type) =>
    mermaidTreemapFamily.parseSource(source, type).diagnostics,
  resolveStructured: (context) => {
    if (context.diagramType !== "treemap") return null;
    const previous = context.previousStructuredModel as
      TreemapModel | undefined;
    const model = parseTreemapSource(
      context.source,
      previous?.diagramType === "treemap" && previous.version === 2
        ? previous
        : undefined,
    );
    if (!model)
      return {
        kind: "source-first",
        source: context.source,
        runtime: context.runtime,
        diagramType: "treemap",
        diagnostics: [],
        reason: mermaidMessages.mmdImportInvalid(),
      };
    return {
      kind: "resolved",
      source: context.source,
      runtime: context.runtime,
      diagramType: "treemap",
      structuredModel: model,
      diagnostics: treemapFamilyDiagnostics(model),
      capabilities: treemapEditorCapabilities(context.source, model),
    };
  },
});
