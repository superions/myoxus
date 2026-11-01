// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MERMAID_FLOWCHART_CORE_SHAPES,
  MERMAID_FLOWCHART_SHAPES,
} from "../../mermaid-block-constants.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { routeFlowchartCreatedEdge } from "./edge-routing.js";
import { flowchartNodeElementStyle } from "./gfx-style-projection.js";
import {
  flowchartLabelTypography,
  measureFlowchartNode,
} from "./label-geometry.js";
import { resolveMermaidGfxTheme } from "../../mermaid-gfx-theme.js";
import { flowchartClickStatementNodeId } from "../../engine/flowchart-node.js";
import {
  flowchartModelData,
  withFlowchartComments,
} from "../../engine/flowchart-model.js";

function cloneModel(model: MermaidVisualModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidVisualModel;
}

function nextId(model: MermaidVisualModel, prefix: string) {
  const existing = new Set([
    ...model.nodes.map((node) => node.id),
    ...(model.subgraphs ?? []).map((subgraph) => subgraph.id),
    ...model.edges.flatMap((edge) => (edge.mermaidId ? [edge.mermaidId] : [])),
  ]);
  let index = model.nodes.length + 1;
  while (existing.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function nextCopiedId(base: string, used: Set<string>) {
  let index = 1;
  let candidate = `${base}_copy`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}_copy${index}`;
  }
  used.add(candidate);
  return candidate;
}

function duplicateFlowchartNodeStatement(
  statement: string,
  nodeIds: ReadonlyMap<string, string>,
) {
  const click = /^(\s*click\s+)([A-Za-z0-9_][\w-]*)([\s\S]*)$/i.exec(statement);
  if (click?.[1] && click[2] && nodeIds.has(click[2])) {
    return `${click[1]}${nodeIds.get(click[2])}${click[3] ?? ""}`;
  }
  const style = /^(\s*style\s+)([A-Za-z0-9_][\w-]*)([\s\S]*)$/i.exec(statement);
  if (style?.[1] && style[2] && nodeIds.has(style[2])) {
    return `${style[1]}${nodeIds.get(style[2])}${style[3] ?? ""}`;
  }
  const classStatement = /^(\s*class\s+)([^\s]+)([\s\S]*)$/i.exec(statement);
  if (!classStatement?.[1] || !classStatement[2]) return null;
  const copiedIds = classStatement[2]
    .split(",")
    .flatMap((nodeId) => (nodeIds.has(nodeId) ? [nodeIds.get(nodeId)!] : []));
  return copiedIds.length
    ? `${classStatement[1]}${copiedIds.join(",")}${classStatement[3] ?? ""}`
    : null;
}

export function duplicateFlowchartGfxSelection(
  model: MermaidVisualModel,
  selectedNodeIds: readonly string[],
  offset: Readonly<{ x: number; y: number }>,
) {
  if (
    model.diagramType !== "flowchart" &&
    model.diagramType !== "flowchart-elk"
  ) {
    return null;
  }
  const selected = new Set(selectedNodeIds);
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
  const sourceNodes = selectedNodeIds.flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    return node ? [node] : [];
  });
  if (
    sourceNodes.length !== selected.size ||
    sourceNodes.length !== selectedNodeIds.length ||
    sourceNodes.length === 0
  ) {
    return null;
  }
  const parentByNodeId = new Map<string, string>();
  for (const node of sourceNodes) {
    const owners = (model.subgraphs ?? []).filter((subgraph) =>
      subgraph.nodeIds.includes(node.id),
    );
    if (owners.length > 1) return null;
    parentByNodeId.set(node.id, owners[0]?.id ?? "");
  }

  const next = cloneModel(model);
  const usedIds = new Set([
    ...model.nodes.map((node) => node.id),
    ...model.edges.map((edge) => edge.id),
    ...model.edges.flatMap((edge) => (edge.mermaidId ? [edge.mermaidId] : [])),
    ...(model.subgraphs ?? []).map((subgraph) => subgraph.id),
  ]);
  const nodeIds = new Map<string, string>();
  const copiedNodes = sourceNodes.map((node) => {
    const id = nextCopiedId(node.id, usedIds);
    nodeIds.set(node.id, id);
    return {
      ...JSON.parse(JSON.stringify(node)),
      id,
      x: node.x + offset.x,
      y: node.y + offset.y,
    } as MermaidVisualNode;
  });
  const edgeIds = new Map<string, string>();
  const copiedEdges = model.edges.flatMap((edge) => {
    const source = nodeIds.get(edge.source);
    const target = nodeIds.get(edge.target);
    if (!source || !target) return [];
    const id = nextCopiedId(edge.id, usedIds);
    const mermaidId = edge.mermaidId
      ? nextCopiedId(edge.mermaidId, usedIds)
      : undefined;
    edgeIds.set(edge.id, id);
    if (edge.mermaidId) edgeIds.set(edge.mermaidId, mermaidId ?? id);
    return [
      {
        ...JSON.parse(JSON.stringify(edge)),
        id,
        mermaidId,
        source,
        target,
      } as MermaidVisualEdge,
    ];
  });
  next.nodes.push(...copiedNodes);
  next.edges.push(...copiedEdges);
  next.subgraphs = (next.subgraphs ?? []).map((subgraph) => ({
    ...subgraph,
    nodeIds: [
      ...subgraph.nodeIds,
      ...sourceNodes.flatMap((node) =>
        parentByNodeId.get(node.id) === subgraph.id
          ? [nodeIds.get(node.id)!]
          : [],
      ),
    ],
  }));
  const comments = flowchartModelData(model).comments;
  const usedCommentIds = new Set(comments.map((comment) => comment.id));
  const copiedComments = comments.flatMap((comment) => {
    const anchorId =
      comment.anchorKind === "node" && comment.anchorId
        ? nodeIds.get(comment.anchorId)
        : comment.anchorKind === "edge" && comment.anchorId
          ? edgeIds.get(comment.anchorId)
          : undefined;
    if (!anchorId) return [];
    return [
      {
        ...comment,
        anchorId,
        id: nextCopiedId(comment.id, usedCommentIds),
      },
    ];
  });
  next.styleStatements = [
    ...(next.styleStatements ?? []),
    ...(model.styleStatements ?? []).flatMap((statement) => {
      const copied = duplicateFlowchartNodeStatement(statement, nodeIds);
      return copied ? [copied] : [];
    }),
  ];
  return {
    nodeIds: copiedNodes.map(({ id }) => id),
    visualModel: withFlowchartComments(next, [...comments, ...copiedComments]),
  };
}

function nodeLabel(shape: MermaidVisualNodeShape, index: number) {
  if (shape === "diamond" || shape === "diam") return `Decision ${index}`;
  if (shape === "rounded" || shape === "stadium") return `Start ${index}`;
  if (
    shape === "database" ||
    shape === "datastore" ||
    shape === "h-cyl" ||
    shape === "lin-cyl"
  ) {
    return `Data ${index}`;
  }
  if (shape === "doc" || shape === "docs") return `Document ${index}`;
  if (shape === "subroutine" || shape === "fr-rect") {
    return `Subprocess ${index}`;
  }
  return `Process ${index}`;
}

export function createFlowchartGfxNode(
  model: MermaidVisualModel,
  requestedShape?: MermaidVisualNodeShape,
  placement?: { readonly centerX: number; readonly centerY: number },
): MermaidVisualNode {
  const shape = requestedShape ?? "rect";
  const node: MermaidVisualNode = {
    height: 0,
    id: nextId(model, "N"),
    label: nodeLabel(shape, model.nodes.length + 1),
    shape,
    width: 0,
    x: 0,
    y: 0,
  };
  const { width, height } = measureFlowchartNode(
    node,
    flowchartLabelTypography(flowchartNodeElementStyle(model, node)),
  );
  const gap = resolveMermaidGfxTheme().typography.lineHeight * 3;
  const last = model.nodes.at(-1);
  return {
    ...node,
    height,
    width,
    x:
      placement === undefined
        ? model.direction === "LR"
          ? last
            ? last.x + last.width + gap
            : 0
          : (last?.x ?? 0)
        : placement.centerX - width / 2,
    y:
      placement === undefined
        ? model.direction === "LR"
          ? (last?.y ?? 0)
          : last
            ? last.y + last.height + gap
            : 0
        : placement.centerY - height / 2,
  };
}

export function canConnectFlowchartGfxNodes(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
) {
  return (
    sourceId !== targetId &&
    model.nodes.some((node) => node.id === sourceId) &&
    model.nodes.some((node) => node.id === targetId)
  );
}

export function createFlowchartGfxEdge(
  model: MermaidVisualModel,
  sourceId: string,
  targetId: string,
): MermaidVisualEdge | null {
  if (!canConnectFlowchartGfxNodes(model, sourceId, targetId)) return null;
  const ids = new Set(model.edges.map((edge) => edge.id));
  let index = model.edges.length + 1;
  while (ids.has(`edge-${sourceId}-${targetId}-${index}`)) index += 1;
  return routeFlowchartCreatedEdge(model, {
    id: `edge-${sourceId}-${targetId}-${index}`,
    label: "",
    linkType: "arrow",
    source: sourceId,
    style: "solid",
    target: targetId,
  });
}

export function reconnectFlowchartGfxEdge(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  endpoint: "source" | "target",
  nodeId: string,
) {
  const source = endpoint === "source" ? nodeId : edge.source;
  const target = endpoint === "target" ? nodeId : edge.target;
  if (!canConnectFlowchartGfxNodes(model, source, target)) return null;
  return {
    ...edge,
    source,
    sourceAttachment: endpoint === "source" ? undefined : edge.sourceAttachment,
    sourcePortId: endpoint === "source" ? undefined : edge.sourcePortId,
    sourcePosition: endpoint === "source" ? undefined : edge.sourcePosition,
    target,
    targetAttachment: endpoint === "target" ? undefined : edge.targetAttachment,
    targetPortId: endpoint === "target" ? undefined : edge.targetPortId,
    targetPosition: endpoint === "target" ? undefined : edge.targetPosition,
  };
}

export function syncFlowchartGfxSubgraphMembership(model: MermaidVisualModel) {
  if (!model.subgraphs?.length) return model;
  const validNodeIds = new Set(model.nodes.map((node) => node.id));
  const ownedNodeIds = new Set<string>();
  for (const subgraph of model.subgraphs) {
    subgraph.nodeIds = subgraph.nodeIds.filter((nodeId) => {
      if (!validNodeIds.has(nodeId) || ownedNodeIds.has(nodeId)) return false;
      ownedNodeIds.add(nodeId);
      return true;
    });
  }
  return model;
}

function subgraphBounds(model: MermaidVisualModel, nodeIds: string[]) {
  const nodes = model.nodes.filter((node) => nodeIds.includes(node.id));
  if (nodes.length === 0) {
    return { height: 220, width: 300, x: 24, y: 24 };
  }
  const left = Math.min(...nodes.map((node) => node.x)) - 36;
  const top = Math.min(...nodes.map((node) => node.y)) - 52;
  const right = Math.max(...nodes.map((node) => node.x + node.width)) + 36;
  const bottom = Math.max(...nodes.map((node) => node.y + node.height)) + 40;
  return {
    height: Math.max(160, bottom - top),
    width: Math.max(240, right - left),
    x: Math.max(0, left),
    y: Math.max(0, top),
  };
}

export function createFlowchartGfxSubgraph(
  model: MermaidVisualModel,
  selectedNodeIds: readonly string[],
): MermaidVisualSubgraph | null {
  const validNodeIds = new Set(model.nodes.map((node) => node.id));
  const nodeIds = [...new Set(selectedNodeIds)];
  if (
    nodeIds.length < 2 ||
    nodeIds.some((nodeId) => !validNodeIds.has(nodeId))
  ) {
    return null;
  }
  const ownerIds = new Set(
    nodeIds.map(
      (nodeId) =>
        model.subgraphs?.find((subgraph) => subgraph.nodeIds.includes(nodeId))
          ?.id ?? "",
    ),
  );
  if (ownerIds.size !== 1) return null;
  const parentId = [...ownerIds][0] || undefined;
  const existingIds = new Set([
    ...model.nodes.map((node) => node.id),
    ...(model.subgraphs ?? []).map((subgraph) => subgraph.id),
    ...model.edges.flatMap((edge) => (edge.mermaidId ? [edge.mermaidId] : [])),
  ]);
  let index = existingIds.size + 1;
  while (existingIds.has(`SG${index}`)) index += 1;
  const id = `SG${index}`;
  return {
    ...subgraphBounds(model, nodeIds),
    direction: model.direction,
    id,
    nodeIds,
    parentId,
    title: `Group ${index}`,
  };
}

export function applyFlowchartCreatedSubgraphMembership(
  model: MermaidVisualModel,
  subgraphId: string,
  selectedNodeIds: readonly string[],
) {
  const selected = new Set(selectedNodeIds);
  return {
    ...model,
    subgraphs: (model.subgraphs ?? []).map((subgraph) => ({
      ...subgraph,
      nodeIds:
        subgraph.id === subgraphId
          ? subgraph.nodeIds.filter((nodeId) => selected.has(nodeId))
          : subgraph.nodeIds.filter((nodeId) => !selected.has(nodeId)),
    })),
  };
}

export function reparentFlowchartGfxNodes(
  model: MermaidVisualModel,
  nodeIds: readonly string[],
  subgraphId: string,
) {
  const next = cloneModel(model);
  const validNodeIds = new Set(next.nodes.map((node) => node.id));
  const selected = new Set(
    nodeIds.filter((nodeId) => validNodeIds.has(nodeId)),
  );
  if (selected.size === 0) return next;
  if (subgraphId && !next.subgraphs?.some(({ id }) => id === subgraphId)) {
    return next;
  }
  next.subgraphs = (next.subgraphs ?? []).map((subgraph) => ({
    ...subgraph,
    nodeIds: subgraph.nodeIds.filter((nodeId) => !selected.has(nodeId)),
  }));
  if (subgraphId) {
    const target = next.subgraphs.find(({ id }) => id === subgraphId);
    if (target) target.nodeIds.push(...selected);
  }
  return next;
}

export function flowchartSubgraphDescendantIds(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  const descendants = new Set<string>();
  const visit = (parentId: string) => {
    for (const subgraph of model.subgraphs ?? []) {
      if (subgraph.parentId !== parentId || descendants.has(subgraph.id)) {
        continue;
      }
      descendants.add(subgraph.id);
      visit(subgraph.id);
    }
  };
  visit(subgraphId);
  return descendants;
}

export function canReparentFlowchartGfxSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  parentId: string,
) {
  return Boolean(
    model.subgraphs?.some(({ id }) => id === subgraphId) &&
    parentId !== subgraphId &&
    (!parentId ||
      (model.subgraphs?.some(({ id }) => id === parentId) &&
        !flowchartSubgraphDescendantIds(model, subgraphId).has(parentId))),
  );
}

export function reparentFlowchartGfxSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  parentId: string,
) {
  const next = cloneModel(model);
  if (!canReparentFlowchartGfxSubgraph(next, subgraphId, parentId)) return next;
  next.subgraphs = (next.subgraphs ?? []).map((subgraph) =>
    subgraph.id === subgraphId
      ? { ...subgraph, parentId: parentId || undefined }
      : subgraph,
  );
  return next;
}

export function deleteFlowchartGfxSelection(
  model: MermaidVisualModel,
  selection: {
    readonly edgeId?: string;
    readonly edgeIds?: readonly string[];
    readonly nodeId?: string;
    readonly nodeIds?: readonly string[];
    readonly subgraphId?: string;
    readonly subgraphIds?: readonly string[];
  },
) {
  const next = cloneModel(model);
  const removeAnchoredComments = (
    target: MermaidVisualModel,
    removed: ReadonlySet<string>,
    anchorKind: "edge" | "node" | "subgraph",
  ) =>
    withFlowchartComments(
      target,
      flowchartModelData(target).comments.filter(
        (comment) =>
          comment.anchorKind !== anchorKind ||
          !comment.anchorId ||
          !removed.has(comment.anchorId),
      ),
    );
  const selectedSubgraphIds = new Set([
    ...(selection.subgraphIds ?? []),
    ...(selection.subgraphId ? [selection.subgraphId] : []),
  ]);
  const selectedEdgeIds = new Set([
    ...(selection.edgeIds ?? []),
    ...(selection.edgeId ? [selection.edgeId] : []),
  ]);
  const selectedNodeIds = new Set([
    ...(selection.nodeIds ?? []),
    ...(selection.nodeId ? [selection.nodeId] : []),
  ]);
  if (
    selectedSubgraphIds.size === 0 &&
    selectedEdgeIds.size === 0 &&
    selectedNodeIds.size === 0
  ) {
    return next;
  }

  const parentBySubgraphId = new Map(
    (next.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph.parentId]),
  );
  const nearestRemainingParent = (parentId: string | undefined) => {
    let candidate = parentId;
    while (candidate && selectedSubgraphIds.has(candidate)) {
      candidate = parentBySubgraphId.get(candidate);
    }
    return candidate;
  };
  next.subgraphs = (next.subgraphs ?? [])
    .filter((subgraph) => !selectedSubgraphIds.has(subgraph.id))
    .map((subgraph) => ({
      ...subgraph,
      nodeIds: subgraph.nodeIds.filter(
        (nodeId) => !selectedNodeIds.has(nodeId),
      ),
      parentId: nearestRemainingParent(subgraph.parentId),
    }));
  next.nodes = next.nodes.filter((node) => !selectedNodeIds.has(node.id));
  const removedEdgeIds = new Set(
    next.edges
      .filter(
        (edge) =>
          selectedEdgeIds.has(edge.id) ||
          selectedNodeIds.has(edge.source) ||
          selectedNodeIds.has(edge.target) ||
          selectedSubgraphIds.has(edge.source) ||
          selectedSubgraphIds.has(edge.target),
      )
      .map((edge) => edge.id),
  );
  next.edges = next.edges.filter((edge) => !removedEdgeIds.has(edge.id));
  next.styleStatements = (next.styleStatements ?? []).filter(
    (statement) =>
      !selectedNodeIds.has(flowchartClickStatementNodeId(statement) ?? ""),
  );
  return removeAnchoredComments(
    removeAnchoredComments(
      removeAnchoredComments(next, removedEdgeIds, "edge"),
      selectedNodeIds,
      "node",
    ),
    selectedSubgraphIds,
    "subgraph",
  );
}

function replaceNodeLabel(node: MermaidVisualNode, label: string) {
  const displayLabel = node.displayLabel
    ? [label, ...node.displayLabel.split("\n").slice(1)].join("\n")
    : node.displayLabel;
  return { ...node, displayLabel, label };
}

export function renameFlowchartGfxNode(
  model: MermaidVisualModel,
  nodeId: string,
  value: string,
) {
  const next = cloneModel(model);
  next.nodes = next.nodes.map((node) =>
    node.id === nodeId ? replaceNodeLabel(node, value) : node,
  );
  return next;
}

export function renameFlowchartGfxEdge(
  model: MermaidVisualModel,
  edgeId: string,
  value: string,
) {
  const next = cloneModel(model);
  next.edges = next.edges.map((edge) =>
    edge.id === edgeId ? { ...edge, displayLabel: value, label: value } : edge,
  );
  return next;
}

export function renameFlowchartGfxSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  value: string,
) {
  const next = cloneModel(model);
  next.subgraphs = (next.subgraphs ?? []).map((subgraph) =>
    subgraph.id === subgraphId ? { ...subgraph, title: value } : subgraph,
  );
  return next;
}

export function reorderFlowchartGfxSubgraph(
  model: MermaidVisualModel,
  subgraphId: string,
  delta: -1 | 1,
) {
  const next = cloneModel(model);
  const subgraphs = next.subgraphs ?? [];
  const current = subgraphs.find((subgraph) => subgraph.id === subgraphId);
  if (!current) return next;
  const siblings = subgraphs.filter(
    (subgraph) => subgraph.parentId === current.parentId,
  );
  const siblingIndex = siblings.findIndex(
    (subgraph) => subgraph.id === subgraphId,
  );
  const target = siblings[siblingIndex + delta];
  if (!target) return next;
  [siblings[siblingIndex], siblings[siblingIndex + delta]] = [
    siblings[siblingIndex + delta],
    siblings[siblingIndex],
  ];

  const siblingsByParent = new Map<
    string | undefined,
    MermaidVisualSubgraph[]
  >();
  for (const subgraph of subgraphs) {
    const parentSiblings = siblingsByParent.get(subgraph.parentId) ?? [];
    parentSiblings.push(subgraph);
    siblingsByParent.set(subgraph.parentId, parentSiblings);
  }
  siblingsByParent.set(current.parentId, siblings);
  const reordered: MermaidVisualSubgraph[] = [];
  const appendSubtree = (subgraph: MermaidVisualSubgraph) => {
    reordered.push(subgraph);
    for (const child of siblingsByParent.get(subgraph.id) ?? []) {
      appendSubtree(child);
    }
  };
  for (const root of siblingsByParent.get(undefined) ?? []) {
    appendSubtree(root);
  }
  next.subgraphs = reordered;
  return next;
}

export const flowchartGfxShapePalette = {
  all: MERMAID_FLOWCHART_SHAPES,
  core: MERMAID_FLOWCHART_CORE_SHAPES,
};
