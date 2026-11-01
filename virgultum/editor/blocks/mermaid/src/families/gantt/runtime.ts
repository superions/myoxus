// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../i18n.js";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import { mermaidGanttDiagramTitle } from "./diagram-title.js";
import { mermaidGanttFamily } from "./family.js";
import { resolveGanttRuntime } from "./runtime-resolution.js";

export const mermaidGanttRuntime = defineMermaidFamilyRuntime({
  ...mermaidGanttFamily,
  applyGfxVisualToSource: (source) => ({
    diagnostics: [
      {
        code: "gantt.command-required",
        message: mermaidMessages.visualMutationOwnerUnavailable("Gantt"),
        severity: "error" as const,
      },
    ],
    source,
  }),
  diagramTitle: mermaidGanttDiagramTitle,
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveGanttRuntime,
  sourceDiagnostics: (source, type) =>
    mermaidGanttFamily.parseSource(source, type).diagnostics,
});
