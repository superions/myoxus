// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualEndpointPosition,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import type {
  MermaidArchitectureComment,
  MermaidArchitectureConfig,
} from "../../engine/architecture/index.js";
import { validateMermaidArchitectureConfig } from "../../engine/architecture/index.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";

const ARCHITECTURE_FAMILY = "architecture";

export type MermaidArchitectureModelGfxData = {
  readonly alignments: ReadonlyArray<{
    readonly direction: "column" | "row";
    readonly id: string;
    readonly members: readonly string[];
    readonly order: number;
  }>;
  readonly comments?: readonly MermaidArchitectureComment[];
  readonly config?: MermaidArchitectureConfig;
  readonly directives?: readonly string[];
  readonly family: typeof ARCHITECTURE_FAMILY;
};

export type MermaidArchitectureNodeGfxData = {
  readonly family: typeof ARCHITECTURE_FAMILY;
  readonly groupId: string;
  readonly hasIcon: boolean;
  readonly hasLabel: boolean;
  readonly icon: string;
  readonly iconKind: "icon" | "none" | "text";
  readonly intrinsicHeight?: number;
  readonly intrinsicWidth?: number;
  readonly kind: "junction" | "service";
  readonly label: string;
  readonly sourceId?: string;
  readonly typographyKey?: string;
};

export type MermaidArchitectureEdgeGfxData = {
  readonly family: typeof ARCHITECTURE_FAMILY;
  readonly fromArrow: boolean;
  readonly fromGroup: boolean;
  readonly fromPort: string;
  readonly sourceId: string;
  readonly toArrow: boolean;
  readonly toGroup: boolean;
  readonly toPort: string;
};

export type MermaidArchitectureSubgraphGfxData = {
  readonly family: typeof ARCHITECTURE_FAMILY;
  readonly hasIcon: boolean;
  readonly hasLabel: boolean;
  readonly icon: string;
  readonly intrinsicHeight?: number;
  readonly intrinsicWidth?: number;
  readonly label: string;
  readonly parentId: string;
  readonly sourceId?: string;
  readonly typographyKey?: string;
};

function architectureFamilyPayload(value: MermaidVisualFamilyData | undefined) {
  return mermaidVisualFamilyPayload(value, ARCHITECTURE_FAMILY);
}

export function architectureNodeGfxData(
  node: Pick<MermaidVisualNode, "familyData">,
): MermaidArchitectureNodeGfxData | undefined {
  const data = architectureFamilyPayload(node.familyData);
  if (!data) return undefined;
  if (data.kind !== "junction" && data.kind !== "service") return undefined;
  return {
    family: ARCHITECTURE_FAMILY,
    groupId: typeof data.groupId === "string" ? data.groupId : "",
    hasIcon: data.hasIcon === true,
    hasLabel: data.hasLabel === true,
    icon: typeof data.icon === "string" ? data.icon : "",
    iconKind:
      data.iconKind === "icon" ||
      data.iconKind === "none" ||
      data.iconKind === "text"
        ? data.iconKind
        : "none",
    intrinsicHeight:
      typeof data.intrinsicHeight === "number" &&
      Number.isFinite(data.intrinsicHeight) &&
      data.intrinsicHeight > 0
        ? data.intrinsicHeight
        : undefined,
    intrinsicWidth:
      typeof data.intrinsicWidth === "number" &&
      Number.isFinite(data.intrinsicWidth) &&
      data.intrinsicWidth > 0
        ? data.intrinsicWidth
        : undefined,
    kind: data.kind,
    label: typeof data.label === "string" ? data.label : "",
    sourceId: typeof data.sourceId === "string" ? data.sourceId : undefined,
    typographyKey:
      typeof data.typographyKey === "string" ? data.typographyKey : undefined,
  };
}

export function architectureModelGfxData(
  model: Pick<MermaidVisualModel, "familyData">,
): MermaidArchitectureModelGfxData | undefined {
  const data = architectureFamilyPayload(model.familyData);
  if (!data || !Array.isArray(data.alignments)) {
    return undefined;
  }
  const alignments: MermaidArchitectureModelGfxData["alignments"][number][] =
    [];
  for (const value of data.alignments) {
    if (!value || typeof value !== "object") return undefined;
    const alignment = value as Record<string, unknown>;
    if (
      (alignment.direction !== "row" && alignment.direction !== "column") ||
      typeof alignment.id !== "string" ||
      !alignment.id ||
      !Array.isArray(alignment.members) ||
      !alignment.members.every((member) => typeof member === "string") ||
      alignment.members.length < 2 ||
      new Set(alignment.members).size !== alignment.members.length ||
      typeof alignment.order !== "number" ||
      !Number.isFinite(alignment.order)
    ) {
      return undefined;
    }
    alignments.push({
      direction: alignment.direction,
      id: alignment.id,
      members: alignment.members as string[],
      order: alignment.order,
    });
  }
  let comments: MermaidArchitectureComment[] | undefined;
  if (data.comments !== undefined) {
    if (!Array.isArray(data.comments)) return undefined;
    comments = [];
    const commentIds = new Set<string>();
    for (const value of data.comments) {
      if (!value || typeof value !== "object") return undefined;
      const comment = value as Record<string, unknown>;
      if (
        typeof comment.id !== "string" ||
        !comment.id ||
        commentIds.has(comment.id) ||
        typeof comment.line !== "string" ||
        !/^%%(?:\s|$)/.test(comment.line) ||
        ![
          "alignment",
          "diagram",
          "edge",
          "group",
          "junction",
          "metadata",
          "service",
        ].includes(String(comment.anchorKind)) ||
        (comment.anchorId !== undefined &&
          typeof comment.anchorId !== "string") ||
        (comment.position !== "before" && comment.position !== "after")
      ) {
        return undefined;
      }
      commentIds.add(comment.id);
      comments.push({
        ...(typeof comment.anchorId === "string"
          ? { anchorId: comment.anchorId }
          : {}),
        anchorKind:
          comment.anchorKind as MermaidArchitectureComment["anchorKind"],
        id: comment.id,
        line: comment.line,
        position: comment.position,
      });
    }
  }
  if (
    data.directives !== undefined &&
    (!Array.isArray(data.directives) ||
      !data.directives.every((value) => typeof value === "string"))
  ) {
    return undefined;
  }
  const directives = data.directives as string[] | undefined;
  const config =
    data.config &&
    typeof data.config === "object" &&
    !Array.isArray(data.config) &&
    validateMermaidArchitectureConfig(data.config as MermaidArchitectureConfig)
      ? (data.config as MermaidArchitectureConfig)
      : undefined;
  if (data.config !== undefined && !config) return undefined;
  return {
    alignments,
    comments,
    config,
    directives,
    family: ARCHITECTURE_FAMILY,
  };
}

export function architectureModelFamilyData(
  alignments: MermaidArchitectureModelGfxData["alignments"],
  comments?: readonly MermaidArchitectureComment[],
  options?: {
    config?: MermaidArchitectureConfig;
    directives?: readonly string[];
  },
): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(ARCHITECTURE_FAMILY, {
    alignments: alignments.map((alignment) => ({
      ...alignment,
      members: [...alignment.members],
    })),
    ...(comments
      ? { comments: comments.map((comment) => ({ ...comment })) }
      : {}),
    ...(options?.config ? { config: { ...options.config } } : {}),
    ...(options?.directives ? { directives: [...options.directives] } : {}),
  });
}

export function architectureEdgeGfxData(
  edge: Pick<MermaidVisualEdge, "familyData">,
): MermaidArchitectureEdgeGfxData | undefined {
  const data = architectureFamilyPayload(edge.familyData);
  if (!data) return undefined;
  return {
    family: ARCHITECTURE_FAMILY,
    fromArrow: data.fromArrow === true,
    fromGroup: data.fromGroup === true,
    fromPort: typeof data.fromPort === "string" ? data.fromPort : "R",
    sourceId: typeof data.sourceId === "string" ? data.sourceId : "",
    toArrow: data.toArrow !== false,
    toGroup: data.toGroup === true,
    toPort: typeof data.toPort === "string" ? data.toPort : "L",
  };
}

export function architectureSubgraphGfxData(
  subgraph: Pick<MermaidVisualSubgraph, "familyData">,
): MermaidArchitectureSubgraphGfxData | undefined {
  const data = architectureFamilyPayload(subgraph.familyData);
  if (!data) return undefined;
  return {
    family: ARCHITECTURE_FAMILY,
    hasIcon: data.hasIcon === true,
    hasLabel: data.hasLabel === true,
    icon: typeof data.icon === "string" ? data.icon : "",
    intrinsicHeight:
      typeof data.intrinsicHeight === "number" &&
      Number.isFinite(data.intrinsicHeight) &&
      data.intrinsicHeight > 0
        ? data.intrinsicHeight
        : undefined,
    intrinsicWidth:
      typeof data.intrinsicWidth === "number" &&
      Number.isFinite(data.intrinsicWidth) &&
      data.intrinsicWidth > 0
        ? data.intrinsicWidth
        : undefined,
    label: typeof data.label === "string" ? data.label : "",
    parentId: typeof data.parentId === "string" ? data.parentId : "",
    sourceId: typeof data.sourceId === "string" ? data.sourceId : undefined,
    typographyKey:
      typeof data.typographyKey === "string" ? data.typographyKey : undefined,
  };
}

export function architectureNodeFamilyData({
  groupId,
  hasIcon,
  hasLabel,
  icon,
  iconKind,
  intrinsicHeight,
  intrinsicWidth,
  kind,
  label,
  sourceId,
  typographyKey,
}: Omit<MermaidArchitectureNodeGfxData, "family">): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(ARCHITECTURE_FAMILY, {
    groupId,
    hasIcon,
    hasLabel,
    icon,
    iconKind,
    ...(intrinsicHeight === undefined ? {} : { intrinsicHeight }),
    ...(intrinsicWidth === undefined ? {} : { intrinsicWidth }),
    kind,
    label,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(typographyKey === undefined ? {} : { typographyKey }),
  });
}

export function architectureEdgeFamilyData({
  fromArrow = false,
  fromGroup = false,
  fromPort = "R",
  sourceId = "",
  toArrow = true,
  toGroup = false,
  toPort = "L",
}: Partial<
  Omit<MermaidArchitectureEdgeGfxData, "family">
> = {}): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(ARCHITECTURE_FAMILY, {
    fromArrow,
    fromGroup,
    fromPort,
    sourceId,
    toArrow,
    toGroup,
    toPort,
  });
}

export function architectureSubgraphFamilyData({
  hasIcon,
  hasLabel,
  icon,
  intrinsicHeight,
  intrinsicWidth,
  label,
  parentId = "",
  sourceId,
  typographyKey,
}: Omit<
  MermaidArchitectureSubgraphGfxData,
  "family"
>): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(ARCHITECTURE_FAMILY, {
    hasIcon,
    hasLabel,
    icon,
    ...(intrinsicHeight === undefined ? {} : { intrinsicHeight }),
    ...(intrinsicWidth === undefined ? {} : { intrinsicWidth }),
    label,
    parentId,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(typographyKey === undefined ? {} : { typographyKey }),
  });
}

export function architecturePortPosition(
  port: string | undefined,
): MermaidVisualEndpointPosition | undefined {
  const normalizedPort = String(port ?? "").toUpperCase();
  if (normalizedPort === "L") return [0, 0.5];
  if (normalizedPort === "R") return [1, 0.5];
  if (normalizedPort === "T") return [0.5, 0];
  if (normalizedPort === "B") return [0.5, 1];
  return undefined;
}

export function architectureEdgeLinkType(
  data: Pick<MermaidArchitectureEdgeGfxData, "fromArrow" | "toArrow">,
): MermaidVisualEdge["linkType"] {
  if (data.fromArrow && data.toArrow) return "bidirectional";
  if (!data.fromArrow && !data.toArrow) return "open";
  return data.fromArrow ? "reverse" : "arrow";
}

export function architectureGroupIdForVisualNode(
  model: MermaidVisualModel,
  nodeId: string,
) {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return "";
  const storedGroupId = architectureNodeGfxData(node)?.groupId ?? "";
  return storedGroupId &&
    model.subgraphs?.some((subgraph) => subgraph.id === storedGroupId)
    ? storedGroupId
    : "";
}

export function hasFiniteArchitectureGfxGeometry(
  model: Pick<MermaidVisualModel, "diagramType" | "nodes" | "subgraphs">,
) {
  if (model.diagramType !== "architecture") return true;
  return [...model.nodes, ...(model.subgraphs ?? [])].every(
    ({ height, width, x, y }) =>
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0,
  );
}

export function hasValidArchitectureGfxProjection(model: MermaidVisualModel) {
  if (model.diagramType !== "architecture") return true;
  if (model.direction !== "TD" || !hasFiniteArchitectureGfxGeometry(model)) {
    return false;
  }
  const projected = architectureModelGfxData(model);
  if (!projected) return false;
  const nodeIds = new Set<string>();
  const serviceIds = new Set<string>();
  const junctionIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const subgraph of model.subgraphs ?? []) {
    if (!subgraph.id || groupIds.has(subgraph.id) || nodeIds.has(subgraph.id)) {
      return false;
    }
    const data = architectureSubgraphGfxData(subgraph);
    if (!data) return false;
    groupIds.add(subgraph.id);
  }
  for (const node of model.nodes) {
    if (!node.id || nodeIds.has(node.id) || groupIds.has(node.id)) return false;
    const data = architectureNodeGfxData(node);
    if (
      !data ||
      (data.kind === "junction" &&
        (node.shape !== "circle" || node.labelEditable !== false)) ||
      (data.kind === "service" && node.shape !== "subroutine")
    ) {
      return false;
    }
    nodeIds.add(node.id);
    (data.kind === "service" ? serviceIds : junctionIds).add(node.id);
  }
  const subgraphsById = new Map(
    (model.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  for (const subgraph of model.subgraphs ?? []) {
    const data = architectureSubgraphGfxData(subgraph)!;
    if (data.parentId && !groupIds.has(data.parentId)) return false;
    const visited = new Set([subgraph.id]);
    let parentId = data.parentId;
    while (parentId) {
      if (visited.has(parentId)) return false;
      visited.add(parentId);
      const parent = subgraphsById.get(parentId);
      parentId = parent
        ? (architectureSubgraphGfxData(parent)?.parentId ?? "")
        : "";
    }
    if (
      subgraph.nodeIds.some((nodeId) => !nodeIds.has(nodeId)) ||
      new Set(subgraph.nodeIds).size !== subgraph.nodeIds.length
    ) {
      return false;
    }
    const directMemberIds = model.nodes
      .filter((node) => architectureNodeGfxData(node)?.groupId === subgraph.id)
      .map((node) => node.id);
    if (
      directMemberIds.length !== subgraph.nodeIds.length ||
      directMemberIds.some(
        (nodeId, index) => subgraph.nodeIds[index] !== nodeId,
      )
    ) {
      return false;
    }
  }
  for (const node of model.nodes) {
    const groupId = architectureNodeGfxData(node)!.groupId;
    if (groupId && !groupIds.has(groupId)) return false;
  }
  const edgeIds = new Set<string>();
  const edgeSourceIds = new Set<string>();
  for (const edge of model.edges) {
    const data = architectureEdgeGfxData(edge);
    if (
      !data?.sourceId ||
      !edge.id ||
      edgeIds.has(edge.id) ||
      edgeSourceIds.has(data.sourceId) ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      !/^[RLTB]$/.test(data.fromPort) ||
      !/^[RLTB]$/.test(data.toPort)
    ) {
      return false;
    }
    edgeIds.add(edge.id);
    edgeSourceIds.add(data.sourceId);
    const sourceGroup = architectureGroupIdForVisualNode(model, edge.source);
    const targetGroup = architectureGroupIdForVisualNode(model, edge.target);
    if (
      (data.fromGroup
        ? edge.sourceAttachment !== (sourceGroup || undefined)
        : Boolean(edge.sourceAttachment)) ||
      (data.toGroup
        ? edge.targetAttachment !== (targetGroup || undefined)
        : Boolean(edge.targetAttachment)) ||
      edge.sourcePortId !== data.fromPort ||
      edge.targetPortId !== data.toPort ||
      JSON.stringify(edge.sourcePosition) !==
        JSON.stringify(architecturePortPosition(data.fromPort)) ||
      JSON.stringify(edge.targetPosition) !==
        JSON.stringify(architecturePortPosition(data.toPort)) ||
      edge.linkType !== architectureEdgeLinkType(data) ||
      ((data.fromGroup || data.toGroup) &&
        Boolean(sourceGroup) &&
        sourceGroup === targetGroup)
    ) {
      return false;
    }
  }
  const alignmentIds = new Set<string>();
  const alignedMembers = new Set<string>();
  for (const alignment of projected.alignments) {
    if (
      alignmentIds.has(alignment.id) ||
      !Number.isInteger(alignment.order) ||
      alignment.order < 0 ||
      alignment.members.some((member) => !nodeIds.has(member))
    ) {
      return false;
    }
    alignmentIds.add(alignment.id);
    for (const member of alignment.members.map(
      (nodeId) => `${alignment.direction}:${nodeId}`,
    )) {
      if (alignedMembers.has(member)) return false;
      alignedMembers.add(member);
    }
  }
  return (projected.comments ?? []).every((comment) => {
    if (comment.anchorKind === "diagram") {
      return comment.anchorId === undefined || comment.anchorId === "end";
    }
    if (comment.anchorKind === "metadata") {
      return [
        "accessibilityDescription",
        "accessibilityTitle",
        "diagramTitle",
      ].includes(comment.anchorId ?? "");
    }
    if (!comment.anchorId) return false;
    if (comment.anchorKind === "service") {
      return serviceIds.has(comment.anchorId);
    }
    if (comment.anchorKind === "junction") {
      return junctionIds.has(comment.anchorId);
    }
    if (comment.anchorKind === "group") return groupIds.has(comment.anchorId);
    if (comment.anchorKind === "edge") {
      return edgeSourceIds.has(comment.anchorId);
    }
    return alignmentIds.has(comment.anchorId);
  });
}
