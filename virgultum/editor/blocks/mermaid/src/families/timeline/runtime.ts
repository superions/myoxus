// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseTimelineSource,
  type MermaidTimelineModel,
} from "../../engine/timeline/index.js";
import { mermaidMessages } from "../../i18n.js";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type {
  MermaidFamilyRuntimeResolution,
  MermaidFamilyStructuredResolutionContext,
} from "../runtime/contracts.js";
import { mermaidTimelineDiagramTitle } from "./diagram-title.js";
import { mermaidTimelineFamily, timelineFamilyDiagnostics } from "./family.js";
import { timelineEditorCapabilities } from "./host-adapter.js";

function resolveTimelineRuntime(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "timeline") return null;
  const previous = context.previousStructuredModel as
    MermaidTimelineModel | undefined;
  const model = parseTimelineSource(
    context.source,
    previous?.diagramType === "timeline" ? previous : undefined,
  );
  const diagnostics = timelineFamilyDiagnostics(model);
  // A recognized Timeline keeps its visual error surface even with an invalid
  // header. Commands independently require an unambiguous current header.
  return {
    capabilities: timelineEditorCapabilities(context.source, model),
    diagnostics,
    diagramType: "timeline",
    kind: "resolved",
    runtime: context.runtime,
    source: context.source,
    structuredModel: model,
  };
}
export const mermaidTimelineRuntime = defineMermaidFamilyRuntime({
  ...mermaidTimelineFamily,
  applyGfxVisualToSource: (source) => ({
    source,
    diagnostics: [
      {
        code: "timeline.command-required",
        message: mermaidMessages.visualMutationOwnerUnavailable("Timeline"),
        severity: "error",
      },
    ],
  }),
  diagramTitle: mermaidTimelineDiagramTitle,
  parseSourceToGfxVisualModel: () => null,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolveTimelineRuntime,
  sourceDiagnostics: (source, type) =>
    mermaidTimelineFamily.parseSource(source, type).diagnostics,
});
