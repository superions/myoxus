// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGfxLegacyReader } from "../runtime/gfx-family-hooks-contract.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  architectureEdgeFamilyData,
  architectureNodeFamilyData,
  architectureSubgraphFamilyData,
} from "./gfx-data.js";

const LEGACY_KEYS = [
  "mermaidFlowchartVisualStyleVersion",
  "mermaidNodeArchitectureIcon",
  "mermaidEdgeArchitectureFromPort",
  "mermaidEdgeArchitectureToPort",
  "mermaidSubgraphArchitectureGroupIcon",
] as const;

const text = (value: unknown) => (typeof value === "string" ? value : null);
const legacyNode = (read: MermaidGfxLegacyReader) =>
  read("mermaidRole") === "mermaid-flowchart-node" &&
  read("mermaidFlowchartVisualStyleVersion") === "gfx-flowchart-v1";

export function architectureLegacyProjectionFingerprint(
  read: MermaidGfxLegacyReader,
) {
  return LEGACY_KEYS.map((key) => `${key}=${String(read(key) ?? "")}`).join(
    ",",
  );
}

export function readArchitectureLegacyNodeFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  read: MermaidGfxLegacyReader,
) {
  if (diagramType !== "architecture" || !legacyNode(read)) return undefined;
  const icon = text(read("mermaidNodeArchitectureIcon"));
  if (icon === null) return undefined;
  const label = text(read("mermaidNodeLabel")) ?? "";
  const sourceId = text(read("mermaidNodeId")) ?? undefined;
  const shape = read("mermaidNodeShape");
  if (shape !== "circle" && shape !== "subroutine") return undefined;
  const kind = shape === "circle" ? "junction" : "service";
  return architectureNodeFamilyData({
    groupId: "",
    hasIcon: Boolean(icon),
    hasLabel: kind === "service" && Boolean(label),
    icon,
    iconKind: icon ? "icon" : "none",
    kind,
    label,
    sourceId,
  });
}

export function readArchitectureLegacyEdgeFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  read: MermaidGfxLegacyReader,
) {
  if (
    diagramType !== "architecture" ||
    read("mermaidRole") !== "mermaid-flowchart-edge"
  )
    return undefined;
  const fromPort = text(read("mermaidEdgeArchitectureFromPort"));
  const toPort = text(read("mermaidEdgeArchitectureToPort"));
  if (
    fromPort === null ||
    toPort === null ||
    !/^[RLTB]$/.test(fromPort) ||
    !/^[RLTB]$/.test(toPort)
  )
    return undefined;
  return architectureEdgeFamilyData({ fromPort, toPort });
}

export function readArchitectureLegacySubgraphFamilyData(
  diagramType: MermaidVisualModel["diagramType"],
  read: MermaidGfxLegacyReader,
) {
  if (
    diagramType !== "architecture" ||
    read("mermaidRole") !== "mermaid-flowchart-subgraph"
  )
    return undefined;
  const icon = text(read("mermaidSubgraphArchitectureGroupIcon"));
  if (icon === null) return undefined;
  const label = text(read("mermaidSubgraphTitle")) ?? "";
  return architectureSubgraphFamilyData({
    hasIcon: Boolean(icon),
    hasLabel: Boolean(label),
    icon,
    label,
    parentId: "",
  });
}
