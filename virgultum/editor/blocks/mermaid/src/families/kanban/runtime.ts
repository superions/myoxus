// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidKanbanSource,
  type MermaidKanbanModel,
} from "../../engine/kanban/index.js";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type {
  MermaidFamilyStructuredResolutionContext,
  MermaidFamilyRuntimeResolution,
} from "../runtime/contracts.js";
import { mermaidKanbanFamily, kanbanFamilyDiagnostics } from "./family.js";
import { kanbanEditorCapabilities } from "./host-adapter.js";
function resolveKanban(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "kanban") return null;
  const previous = context.previousStructuredModel as
    MermaidKanbanModel | undefined;
  const model = parseMermaidKanbanSource(
    context.source,
    previous?.diagramType === "kanban" ? previous : undefined,
  );
  if (!model)
    return {
      kind: "source-first",
      reason: "Kanban",
      diagramType: "kanban",
      source: context.source,
      runtime: context.runtime,
      diagnostics: context.diagnostics,
    };
  // Global ambiguity can only retain a previously valid projection, never invent writable objects.
  if (
    model.ambiguous &&
    previous?.diagramType === "kanban" &&
    (!previous.ambiguous || previous.staleProjection)
  ) {
    model.columns = previous.columns.map((column) => ({
      ...column,
      writable: false,
    }));
    model.cards = previous.cards.map((card) => ({ ...card, writable: false }));
    model.comments = previous.comments;
    model.staleProjection = true;
  } else if (model.ambiguous) {
    model.columns = [];
    model.cards = [];
    model.comments = [];
  }
  return {
    kind: "resolved",
    structuredModel: model,
    capabilities: kanbanEditorCapabilities(context.source, model),
    diagnostics: kanbanFamilyDiagnostics(model),
    diagramType: "kanban",
    source: context.source,
    runtime: context.runtime,
  };
}
export const mermaidKanbanRuntime = defineMermaidFamilyRuntime({
  ...mermaidKanbanFamily,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveKanban,
  parseSourceToGfxVisualModel: () => null,
  applyGfxVisualToSource: (source) => ({ source, diagnostics: [] }),
  sourceDiagnostics: (source, type) =>
    mermaidKanbanFamily.parseSource(source, type).diagnostics,
});
