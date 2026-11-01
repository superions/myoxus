// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidJourneySource,
  type MermaidJourneyModel,
} from "../../engine/journey/index.js";
import { mermaidJourneyDiagramTitle } from "./diagram-title.js";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type {
  MermaidFamilyStructuredResolutionContext,
  MermaidFamilyRuntimeResolution,
} from "../runtime/contracts.js";
import { mermaidJourneyFamily, journeyFamilyDiagnostics } from "./family.js";
import { journeyEditorCapabilities } from "./host-adapter.js";
function resolveJourney(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "journey") return null;
  const previous = context.previousStructuredModel as
    MermaidJourneyModel | undefined;
  const model = parseMermaidJourneySource(
    context.source,
    previous?.diagramType === "journey" ? previous : undefined,
  );
  if (!model)
    return {
      kind: "source-first",
      reason: "Journey",
      diagramType: "journey",
      source: context.source,
      runtime: context.runtime,
      diagnostics: context.diagnostics,
    };
  // Global ambiguity can only retain a previously valid projection, never invent writable objects.
  if (
    model.ambiguous &&
    previous?.diagramType === "journey" &&
    (!previous.ambiguous || previous.staleProjection)
  ) {
    model.sections = previous.sections.map((column) => ({
      ...column,
      writable: false,
    }));
    model.steps = previous.steps.map((card) => ({ ...card, writable: false }));
    model.comments = previous.comments;
    model.staleProjection = true;
  } else if (model.ambiguous) {
    model.sections = [];
    model.steps = [];
    model.comments = [];
  }
  return {
    kind: "resolved",
    structuredModel: model,
    capabilities: journeyEditorCapabilities(context.source, model),
    diagnostics: journeyFamilyDiagnostics(model),
    diagramType: "journey",
    source: context.source,
    runtime: context.runtime,
  };
}
export const mermaidJourneyRuntime = defineMermaidFamilyRuntime({
  ...mermaidJourneyFamily,
  diagramTitle: mermaidJourneyDiagramTitle,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveJourney,
  parseSourceToGfxVisualModel: () => null,
  applyGfxVisualToSource: (source) => ({ source, diagnostics: [] }),
  sourceDiagnostics: (source, type) =>
    mermaidJourneyFamily.parseSource(source, type).diagnostics,
});
