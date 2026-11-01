// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidGanttSource } from "../../engine/gantt/parser.js";
import type { MermaidGanttModel } from "../../engine/gantt/types.js";
import { mermaidMessages } from "../../i18n.js";
import type {
  MermaidFamilyResolvedRuntimeResolution,
  MermaidFamilyRuntimeResolution,
  MermaidFamilyStructuredResolutionContext,
} from "../runtime/contracts.js";
import { ganttFamilyDiagnostics } from "./family.js";
import { ganttEditorCapabilities } from "./host-adapter.js";

export function resolveGanttRuntime(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "gantt") return null;
  const previous = context.previousStructuredModel as
    MermaidGanttModel | undefined;
  const model = parseMermaidGanttSource(
    context.source,
    previous?.diagramType === "gantt" && previous.version === 2
      ? previous
      : undefined,
  );
  if (!model) {
    return {
      diagramType: "gantt",
      diagnostics: [],
      kind: "source-first",
      reason: mermaidMessages.mmdImportInvalid(),
      runtime: context.runtime,
      source: context.source,
    };
  }
  const resolved: MermaidFamilyResolvedRuntimeResolution = {
    capabilities: ganttEditorCapabilities(context.source, model),
    diagnostics: ganttFamilyDiagnostics(model),
    diagramType: "gantt",
    kind: "resolved",
    runtime: context.runtime,
    source: context.source,
    structuredModel: model,
  };
  return resolved;
}
