// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidPacketSource,
  type MermaidPacketModel,
} from "../../engine/packet/index.js";
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type {
  MermaidFamilyStructuredResolutionContext,
  MermaidFamilyRuntimeResolution,
} from "../runtime/contracts.js";
import { mermaidPacketFamily, packetFamilyDiagnostics } from "./family.js";
import { packetEditorCapabilities } from "./host-adapter.js";
import { mermaidPacketDiagramTitle } from "./diagram-title.js";
function resolvePacket(
  context: MermaidFamilyStructuredResolutionContext,
): MermaidFamilyRuntimeResolution | null {
  if (context.diagramType !== "packet") return null;
  const previous = context.previousStructuredModel as
    MermaidPacketModel | undefined;
  const model = parseMermaidPacketSource(
    context.source,
    previous?.diagramType === "packet" ? previous : undefined,
  );
  if (!model)
    return {
      kind: "source-first",
      reason: "Packet",
      diagramType: "packet",
      source: context.source,
      runtime: context.runtime,
      diagnostics: context.diagnostics,
    };
  const invalid =
    model.issues.length ||
    model.diagnostics.length ||
    !model.configResolution.mutableGeometry;
  const projection =
    invalid &&
    previous?.diagramType === "packet" &&
    !previous.issues.length &&
    !previous.diagnostics.length &&
    previous.configResolution.mutableGeometry
      ? previous
      : undefined;
  return {
    kind: "resolved",
    structuredModel: model,
    capabilities: packetEditorCapabilities(context.source, model, projection),
    diagnostics: packetFamilyDiagnostics(model),
    diagramType: "packet",
    source: context.source,
    runtime: context.runtime,
  };
}
export const mermaidPacketRuntime = defineMermaidFamilyRuntime({
  ...mermaidPacketFamily,
  diagramTitle: mermaidPacketDiagramTitle,
  renderSurface: () => "core-facade" as const,
  resolveStructured: resolvePacket,
  parseSourceToGfxVisualModel: () => null,
  applyGfxVisualToSource: (source) => ({ source, diagnostics: [] }),
  sourceDiagnostics: (source, type) =>
    mermaidPacketFamily.parseSource(source, type).diagnostics,
});
