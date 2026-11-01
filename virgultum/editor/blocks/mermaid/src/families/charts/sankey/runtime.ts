// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyModel } from "../../../engine/charts/sankey/model.js";
import { parseSankeySource } from "../../../engine/charts/sankey/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import { defineMermaidFamilyRuntime } from "../../runtime/factory.js";
import { mermaidSankeyFamily, sankeyFamilyDiagnostics } from "./family.js";
import { sankeyEditorCapabilities } from "./host-adapter.js";

export const mermaidSankeyRuntime = defineMermaidFamilyRuntime({
  ...mermaidSankeyFamily,
  applyGfxVisualToSource: (source) => ({
    source,
    diagnostics: [
      {
        code: "sankey.command-required",
        severity: "error",
        message: mermaidMessages.visualMutationOwnerUnavailable("Sankey"),
      },
    ],
  }),
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  sourceDiagnostics: (source, type) =>
    mermaidSankeyFamily.parseSource(source, type).diagnostics,
  resolveStructured: (context) => {
    if (context.diagramType !== "sankey") return null;
    const previous = context.previousStructuredModel as SankeyModel | undefined;
    const model = parseSankeySource(
      context.source,
      previous?.diagramType === "sankey" && previous.version === 2
        ? previous
        : undefined,
    );
    if (!model)
      return {
        kind: "source-first",
        source: context.source,
        runtime: context.runtime,
        diagramType: "sankey",
        diagnostics: [],
        reason: mermaidMessages.mmdImportInvalid(),
      };
    return {
      kind: "resolved",
      source: context.source,
      runtime: context.runtime,
      diagramType: "sankey",
      structuredModel: model,
      diagnostics: sankeyFamilyDiagnostics(model),
      capabilities: sankeyEditorCapabilities(context.source, model),
    };
  },
});
