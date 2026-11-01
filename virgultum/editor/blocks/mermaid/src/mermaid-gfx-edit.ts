import type {
  MermaidVisualEdgeLinkType,
  MermaidVisualEdgeStyle,
  MermaidVisualSemanticStyle,
} from "./families/runtime/gfx-model.js";

export type MermaidGfxNodeStyleClassEdit = {
  nodeId: string;
  styleClass: MermaidVisualSemanticStyle | "";
};

export type MermaidGfxEdgeStyleEdit = {
  edgeId: string;
  style: MermaidVisualEdgeStyle;
};

export type MermaidGfxEdgeLinkTypeEdit = {
  edgeId: string;
  linkType: MermaidVisualEdgeLinkType;
};

export type MermaidGfxEdgeStyleStatementEdit = {
  edgeId: string;
  visualStyle: MermaidVisualSemanticStyle | "";
};

export function resolveMermaidGfxSubgraphTitleEdit({
  subgraphId,
  value,
}: {
  subgraphId: string;
  value: string;
}) {
  if (!subgraphId) return null;
  return {
    coalesceKey: `flowchart-subgraph-title:${subgraphId}`,
    subgraphId,
    title: value,
  };
}

export function resolveMermaidGfxNodeStyleClassEdit({
  nodeId,
  value,
}: {
  nodeId: string;
  value: string;
}): MermaidGfxNodeStyleClassEdit | null {
  if (!nodeId) return null;
  return {
    nodeId,
    styleClass: value as MermaidVisualSemanticStyle | "",
  };
}

export function resolveMermaidGfxEdgeStyleEdit({
  edgeId,
  value,
}: {
  edgeId: string;
  value: string;
}): MermaidGfxEdgeStyleEdit | null {
  if (!edgeId) return null;
  return {
    edgeId,
    style: value as MermaidVisualEdgeStyle,
  };
}

export function resolveMermaidGfxEdgeLinkTypeEdit({
  edgeId,
  value,
}: {
  edgeId: string;
  value: string;
}): MermaidGfxEdgeLinkTypeEdit | null {
  if (!edgeId) return null;
  return {
    edgeId,
    linkType: value as MermaidVisualEdgeLinkType,
  };
}

export function resolveMermaidGfxEdgeStyleStatementEdit({
  edgeId,
  value,
}: {
  edgeId: string;
  value: string;
}): MermaidGfxEdgeStyleStatementEdit | null {
  if (!edgeId) return null;
  return {
    edgeId,
    visualStyle: value as MermaidVisualSemanticStyle | "",
  };
}
