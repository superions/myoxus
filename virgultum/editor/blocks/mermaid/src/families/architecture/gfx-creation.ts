// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import {
  mermaidGfxLayoutMetrics,
  mermaidGfxShapeSize,
  mermaidGfxTypographyKey,
} from "../../mermaid-gfx-theme.js";
import { resolveMermaidArchitectureConfig } from "../../engine/architecture/index.js";
import {
  architectureModelGfxData,
  architectureNodeFamilyData,
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import { fitArchitectureOwnerGroupsToDirectChildren } from "./owner-bounds.js";
import { reconcileArchitectureGfxRelationAttachments } from "./gfx-connections.js";
import {
  architectureConfiguredTypography,
  architectureServiceMeasurement,
} from "./layout/measurement.js";
import { architectureIconDisplay } from "./icon-display.js";

const ARCHITECTURE_SHAPES = ["subroutine", "circle"] as const;

export const architectureGfxShapePalette = {
  all: ARCHITECTURE_SHAPES,
  core: ARCHITECTURE_SHAPES,
} as const;

function nextArchitectureId(model: MermaidVisualModel, prefix: string) {
  const existing = new Set([
    ...model.nodes.map((node) => node.id),
    ...(model.subgraphs ?? []).map((subgraph) => subgraph.id),
  ]);
  let index = existing.size + 1;
  while (existing.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function architectureNodePosition(
  model: MermaidVisualModel,
  width: number,
  height: number,
  placement?: { centerX: number; centerY: number },
) {
  if (placement) {
    return {
      x: placement.centerX - width / 2,
      y: placement.centerY - height / 2,
    };
  }
  const last = model.nodes.at(-1);
  const metrics = mermaidGfxLayoutMetrics(
    architectureTypographyForModel(model),
  );
  return model.direction === "LR"
    ? {
        x: last ? last.x + last.width + metrics.inlineGap : 0,
        y: last?.y ?? 0,
      }
    : {
        x: last?.x ?? 0,
        y: last ? last.y + last.height + metrics.blockGap : 0,
      };
}

function architectureTypographyForModel(model: MermaidVisualModel) {
  return architectureConfiguredTypography(
    resolveMermaidArchitectureConfig(
      architectureModelGfxData(model)?.config ?? {},
    ),
  );
}

export function createArchitectureGfxVisualNode(
  model: MermaidVisualModel,
  requestedShape?: MermaidVisualNodeShape,
  placement?: { centerX: number; centerY: number },
): MermaidVisualNode {
  const junction = requestedShape === "circle";
  const id = nextArchitectureId(model, junction ? "junction" : "service");
  const label = junction ? "" : id;
  const typography = architectureTypographyForModel(model);
  const config = resolveMermaidArchitectureConfig(
    architectureModelGfxData(model)?.config ?? {},
  );
  const serviceMeasurement = architectureServiceMeasurement(
    label,
    "",
    false,
    "none",
    typography,
    config.iconSize,
  );
  const width = junction ? config.iconSize : serviceMeasurement.width;
  const height = junction ? config.iconSize : serviceMeasurement.height;
  return {
    ...architectureNodePosition(model, width, height, placement),
    details: junction ? undefined : serviceMeasurement.details,
    displayLabel: label,
    familyData: architectureNodeFamilyData({
      groupId: "",
      hasIcon: false,
      hasLabel: false,
      icon: "",
      iconKind: "none",
      intrinsicHeight: height,
      intrinsicWidth: width,
      kind: junction ? "junction" : "service",
      label,
      typographyKey: mermaidGfxTypographyKey(typography),
    }),
    height,
    id,
    label,
    labelEditable: !junction,
    shape: junction ? "circle" : "subroutine",
    textVerticalAlign: junction ? undefined : "center",
    width,
  };
}

export function normalizeArchitectureGfxVisualNodeDimensions(
  node: MermaidVisualNode,
  model: MermaidVisualModel,
): MermaidVisualNode {
  const architecture = architectureNodeGfxData(node);
  const typography = architectureTypographyForModel(model);
  const config = resolveMermaidArchitectureConfig(
    architectureModelGfxData(model)?.config ?? {},
  );
  const typographyKey = mermaidGfxTypographyKey(typography);
  if (architecture?.kind === "junction") {
    const diameter = config.iconSize;
    return {
      ...node,
      details: undefined,
      displayLabel: "",
      familyData: architectureNodeFamilyData({
        ...architecture,
        intrinsicHeight: diameter,
        intrinsicWidth: diameter,
        typographyKey,
      }),
      height: Math.max(diameter, node.height),
      label: "",
      labelEditable: false,
      width: Math.max(diameter, node.width),
    };
  }
  const label = node.label || node.id;
  const measured = architectureServiceMeasurement(
    label,
    architectureIconDisplay(
      architecture?.icon ?? "",
      architecture?.iconKind ?? "none",
    ),
    architecture?.hasIcon ?? false,
    architecture?.iconKind ?? "none",
    typography,
    config.iconSize,
  );
  return {
    ...node,
    details: measured.details,
    displayLabel: label,
    familyData: architectureNodeFamilyData({
      ...(architecture ?? {
        groupId: "",
        hasIcon: false,
        hasLabel: Boolean(node.label),
        icon: "",
        iconKind: "none" as const,
        kind: "service" as const,
        label: node.label,
      }),
      intrinsicHeight: measured.height,
      intrinsicWidth: measured.width,
      typographyKey,
    }),
    height: Math.max(measured.height, node.height),
    textVerticalAlign: architecture?.hasIcon ? "bottom" : "center",
    width: Math.max(measured.width, node.width),
  };
}

export function createArchitectureGfxVisualSubgraph(
  model: MermaidVisualModel,
  selectedNodeIds: readonly string[],
): MermaidVisualSubgraph | null {
  const selectedNodeIdSet = new Set(selectedNodeIds);
  const selectedNodes = selectedNodeIds.flatMap((nodeId) => {
    const node = model.nodes.find((candidate) => candidate.id === nodeId);
    return node ? [node] : [];
  });
  const parentIds = new Set(
    selectedNodes.map((node) => architectureNodeGfxData(node)?.groupId ?? ""),
  );
  if (
    selectedNodes.length < 2 ||
    selectedNodes.length !== selectedNodeIds.length ||
    selectedNodeIdSet.size !== selectedNodeIds.length ||
    selectedNodes.some((node) => !architectureNodeGfxData(node)) ||
    parentIds.size !== 1
  ) {
    return null;
  }
  const parentId = [...parentIds][0] ?? "";
  const id = nextArchitectureId(model, "group");
  const label = id;
  const typography = architectureTypographyForModel(model);
  const metrics = mermaidGfxLayoutMetrics(typography);
  const titleSize = mermaidGfxShapeSize(label, typography);
  const bounds = {
    height:
      titleSize.height +
      metrics.groupBlockInset +
      (Math.max(...selectedNodes.map((node) => node.y + node.height)) -
        Math.min(...selectedNodes.map((node) => node.y))) +
      metrics.groupBlockInset,
    width:
      Math.max(
        titleSize.width,
        Math.max(...selectedNodes.map((node) => node.x + node.width)) -
          Math.min(...selectedNodes.map((node) => node.x)),
      ) +
      metrics.groupInlineInset * 2,
    x:
      Math.min(...selectedNodes.map((node) => node.x)) -
      metrics.groupInlineInset,
    y:
      Math.min(...selectedNodes.map((node) => node.y)) -
      titleSize.height -
      metrics.groupBlockInset,
  };
  return {
    ...bounds,
    direction: model.direction,
    familyData: architectureSubgraphFamilyData({
      hasIcon: false,
      hasLabel: false,
      icon: "",
      intrinsicHeight: bounds.height,
      intrinsicWidth: bounds.width,
      label,
      parentId,
      typographyKey: mermaidGfxTypographyKey(typography),
    }),
    id,
    nodeIds: selectedNodes.map((node) => node.id),
    title: label,
  };
}

export function applyArchitectureCreatedSubgraphMembership(
  model: MermaidVisualModel,
  subgraphId: string,
  selectedNodeIds: readonly string[],
) {
  if (model.diagramType !== "architecture" || selectedNodeIds.length === 0) {
    return model;
  }
  const selected = new Set(selectedNodeIds);
  return fitArchitectureOwnerGroupsToDirectChildren({
    ...model,
    nodes: model.nodes.map((node) => {
      if (!selected.has(node.id)) return node;
      const architecture = architectureNodeGfxData(node);
      return architecture
        ? {
            ...node,
            familyData: architectureNodeFamilyData({
              ...architecture,
              groupId: subgraphId,
            }),
          }
        : node;
    }),
  });
}

function finalizeArchitectureReparent(model: MermaidVisualModel) {
  return fitArchitectureOwnerGroupsToDirectChildren(
    reconcileArchitectureGfxRelationAttachments(model),
  );
}

export function reparentArchitectureGfxNodes(
  model: MermaidVisualModel,
  nodeIds: readonly string[],
  subgraphId: string,
) {
  if (model.diagramType !== "architecture") return null;
  const selected = new Set(nodeIds);
  if (
    selected.size === 0 ||
    [...selected].some(
      (nodeId) =>
        !model.nodes.some(
          (node) => node.id === nodeId && architectureNodeGfxData(node),
        ),
    ) ||
    (subgraphId &&
      !model.subgraphs?.some(
        (subgraph) =>
          subgraph.id === subgraphId && architectureSubgraphGfxData(subgraph),
      ))
  ) {
    return null;
  }
  return finalizeArchitectureReparent({
    ...model,
    nodes: model.nodes.map((node) => {
      if (!selected.has(node.id)) return node;
      const architecture = architectureNodeGfxData(node)!;
      return {
        ...node,
        familyData: architectureNodeFamilyData({
          ...architecture,
          groupId: subgraphId,
        }),
      };
    }),
  });
}

function architectureSubgraphDescendants(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of model.subgraphs ?? []) {
      if (descendants.has(candidate.id)) continue;
      const parentId = architectureSubgraphGfxData(candidate)?.parentId ?? "";
      if (parentId !== subgraphId && !descendants.has(parentId)) continue;
      descendants.add(candidate.id);
      changed = true;
    }
  }
  return descendants;
}

export function reparentArchitectureGfxSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  parentId: string,
) {
  if (model.diagramType !== "architecture") return null;
  const subgraph = model.subgraphs?.find(
    (candidate) =>
      candidate.id === subgraphId && architectureSubgraphGfxData(candidate),
  );
  if (
    !subgraph ||
    parentId === subgraphId ||
    (parentId &&
      (!model.subgraphs?.some(
        (candidate) =>
          candidate.id === parentId && architectureSubgraphGfxData(candidate),
      ) ||
        architectureSubgraphDescendants(model, subgraphId).has(parentId)))
  ) {
    return null;
  }
  return finalizeArchitectureReparent({
    ...model,
    subgraphs: (model.subgraphs ?? []).map((candidate) => {
      if (candidate.id !== subgraphId) return candidate;
      const architecture = architectureSubgraphGfxData(candidate)!;
      return {
        ...candidate,
        familyData: architectureSubgraphFamilyData({
          ...architecture,
          parentId,
        }),
        parentId: parentId || undefined,
      };
    }),
  });
}
