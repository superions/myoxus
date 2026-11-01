// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bound } from "@virgultum/global/gfx";
import { resolveMermaidArchitectureConfig } from "../../engine/architecture/index.js";

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import {
  architectureEdgeGfxData,
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import {
  MermaidGfxThemeUnavailableError,
  resolveMermaidGfxProjectionTheme,
  resolveMermaidGfxTheme,
} from "../../mermaid-gfx-theme.js";

export type ArchitectureManagedAppearanceElement = {
  readonly color?: string;
  readonly fillColor?: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontStyle?: string;
  readonly fontWeight?: string;
  readonly padding?: readonly number[];
  readonly labelStyle?: {
    readonly color?: string;
    readonly fontFamily?: string;
    readonly fontSize?: number;
    readonly fontStyle?: string;
    readonly fontWeight?: string;
  };
  readonly stroke?: string;
  readonly strokeColor?: string;
  readonly xywh?: string;
};

export function architectureProjectionOwnerAppearanceMatchesTheme(
  model: MermaidVisualModel,
  elements: readonly unknown[],
  connectors: readonly unknown[] = [],
) {
  if (model.diagramType !== "architecture") return true;
  let theme: ReturnType<typeof resolveMermaidGfxTheme>;
  try {
    theme = resolveMermaidGfxTheme();
  } catch (error) {
    if (error instanceof MermaidGfxThemeUnavailableError) return true;
    throw error;
  }
  const { borderColor, surfaceColor, textColor } =
    resolveMermaidGfxProjectionTheme();
  const { typography } = theme;
  const projectedFontSize = resolveMermaidArchitectureConfig(
    architectureModelGfxData(model)?.config ?? {},
  ).fontSize;
  const expectedPadding = [typography.lineHeight / 2, typography.lineHeight];
  const expectedGeometry = [
    ...model.nodes.map(({ height, width }) => ({ height, width })),
    ...(model.subgraphs ?? []).map(({ height, width }) => ({ height, width })),
  ];
  const shapesMatch = elements.every((value, index) => {
    const element = value as ArchitectureManagedAppearanceElement;
    const expected = expectedGeometry[index];
    const bound = element.xywh ? Bound.deserialize(element.xywh) : null;
    return (
      element.color === textColor &&
      element.fillColor === surfaceColor &&
      element.strokeColor === borderColor &&
      element.fontFamily === typography.fontFamily &&
      element.fontSize === projectedFontSize &&
      element.fontStyle === typography.fontStyle &&
      element.fontWeight === typography.fontWeight &&
      element.padding?.length === expectedPadding.length &&
      element.padding.every(
        (padding, paddingIndex) => padding === expectedPadding[paddingIndex],
      ) &&
      Boolean(
        bound &&
        expected &&
        bound.w >= expected.width &&
        bound.h >= expected.height,
      )
    );
  });
  const connectorsMatch = connectors.every((value) => {
    const connector = value as ArchitectureManagedAppearanceElement;
    const labelStyle = connector.labelStyle;
    return (
      connector.stroke === borderColor &&
      (!labelStyle ||
        (labelStyle.color === textColor &&
          labelStyle.fontFamily === typography.fontFamily &&
          labelStyle.fontSize === projectedFontSize &&
          labelStyle.fontStyle === typography.fontStyle &&
          labelStyle.fontWeight === typography.fontWeight))
    );
  });
  return shapesMatch && connectorsMatch;
}

export function preserveArchitectureManagedNodeDimensions(
  model: MermaidVisualModel,
  source: MermaidVisualNode,
  existing: MermaidVisualNode,
) {
  if (model.diagramType !== "architecture") return null;
  const sourceData = architectureNodeGfxData(source);
  const existingData = architectureNodeGfxData(existing);
  return {
    height: reprojectArchitectureDimension(
      sourceData?.intrinsicHeight,
      existing.height,
      existingData?.intrinsicHeight,
    ),
    width: reprojectArchitectureDimension(
      sourceData?.intrinsicWidth,
      existing.width,
      existingData?.intrinsicWidth,
    ),
  };
}

export function preserveArchitectureManagedSubgraphDimensions(
  model: MermaidVisualModel,
  source: MermaidVisualSubgraph,
  existing: MermaidVisualSubgraph,
) {
  if (model.diagramType !== "architecture") return null;
  const sourceData = architectureSubgraphGfxData(source);
  const existingData = architectureSubgraphGfxData(existing);
  return {
    height: reprojectArchitectureDimension(
      sourceData?.intrinsicHeight,
      existing.height,
      existingData?.intrinsicHeight,
    ),
    width: reprojectArchitectureDimension(
      sourceData?.intrinsicWidth,
      existing.width,
      existingData?.intrinsicWidth,
    ),
  };
}

function reprojectArchitectureDimension(
  intrinsic: number | undefined,
  stored: number,
  storedIntrinsic: number | undefined,
) {
  if (intrinsic === undefined) return stored;
  if (storedIntrinsic === undefined) return Math.max(intrinsic, stored);
  return intrinsic + Math.max(0, stored - storedIntrinsic);
}

function architectureEdgeSemanticKey(edge: MermaidVisualEdge) {
  const architecture = architectureEdgeGfxData(edge);
  return JSON.stringify({
    fromArrow: architecture?.fromArrow ?? false,
    fromGroup: architecture?.fromGroup ?? false,
    fromPort: architecture?.fromPort ?? "R",
    label: edge.label,
    source: edge.source,
    target: edge.target,
    toArrow: architecture?.toArrow ?? true,
    toGroup: architecture?.toGroup ?? false,
    toPort: architecture?.toPort ?? "L",
  });
}

function architectureEdgeSourceIdentity(edge: MermaidVisualEdge) {
  return architectureEdgeGfxData(edge)?.sourceId || edge.id;
}

function architectureEdgeEndpointsMatch(
  left: MermaidVisualEdge,
  right: MermaidVisualEdge,
) {
  return (
    left.source === right.source &&
    left.sourceAttachment === right.sourceAttachment &&
    JSON.stringify(left.sourcePosition) ===
      JSON.stringify(right.sourcePosition) &&
    left.target === right.target &&
    left.targetAttachment === right.targetAttachment &&
    JSON.stringify(left.targetPosition) === JSON.stringify(right.targetPosition)
  );
}

/**
 * Reconciles cold-parse identities with the last source-matched edit session.
 * Architecture relation IDs are semantic source identities. A newly created
 * relation can temporarily carry a local GFX ID until its first source write;
 * subsequent reparses retain that GFX identity while replacing every semantic
 * field from the freshly parsed source.
 */
export function reconcileArchitectureVisualProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  {
    preserveEdgeIds = true,
    preserveGeometry = true,
  }: {
    readonly preserveEdgeIds?: boolean;
    readonly preserveGeometry?: boolean;
  } = {},
) {
  if (
    parsed.diagramType !== "architecture" ||
    stored.diagramType !== "architecture"
  ) {
    return null;
  }
  const storedNodes = new Map(stored.nodes.map((node) => [node.id, node]));
  const storedSubgraphs = new Map(
    (stored.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]),
  );
  const unusedStoredEdges = new Set(stored.edges.map((edge) => edge.id));
  const edgeById = new Map(stored.edges.map((edge) => [edge.id, edge]));
  const edgesBySourceIdentity = new Map<string, MermaidVisualEdge[]>();
  for (const edge of stored.edges) {
    const sourceId = architectureEdgeSourceIdentity(edge);
    const matches = edgesBySourceIdentity.get(sourceId) ?? [];
    matches.push(edge);
    edgesBySourceIdentity.set(sourceId, matches);
  }
  const edges = parsed.edges.map((edge) => {
    const exact = edgeById.get(edge.id);
    const sourceIdentityMatches =
      edgesBySourceIdentity
        .get(architectureEdgeSourceIdentity(edge))
        ?.filter((candidate) => unusedStoredEdges.has(candidate.id)) ?? [];
    const semanticKey = architectureEdgeSemanticKey(edge);
    const semanticMatches = stored.edges.filter(
      (candidate) =>
        unusedStoredEdges.has(candidate.id) &&
        architectureEdgeSemanticKey(candidate) === semanticKey,
    );
    const storedEdge =
      (exact && unusedStoredEdges.has(exact.id) ? exact : null) ??
      (sourceIdentityMatches.length === 1 ? sourceIdentityMatches[0] : null) ??
      semanticMatches[0] ??
      null;
    if (!storedEdge) return edge;
    unusedStoredEdges.delete(storedEdge.id);
    const preserveRoute = architectureEdgeEndpointsMatch(edge, storedEdge);
    return {
      ...edge,
      connectorMode: preserveRoute ? storedEdge.connectorMode : undefined,
      id: preserveEdgeIds ? storedEdge.id : edge.id,
      labelPlacement: preserveRoute ? storedEdge.labelPlacement : undefined,
      sourcePosition: edge.sourcePosition,
      targetPosition: edge.targetPosition,
    };
  });

  return {
    ...parsed,
    edges,
    nodes: parsed.nodes.map((node) => {
      const geometry = storedNodes.get(node.id);
      if (!preserveGeometry || !geometry) return node;
      const parsedData = architectureNodeGfxData(node);
      const storedData = architectureNodeGfxData(geometry);
      return {
        ...node,
        height: reprojectArchitectureDimension(
          parsedData?.intrinsicHeight,
          geometry.height,
          storedData?.intrinsicHeight,
        ),
        width: reprojectArchitectureDimension(
          parsedData?.intrinsicWidth,
          geometry.width,
          storedData?.intrinsicWidth,
        ),
        x: geometry.x,
        y: geometry.y,
      };
    }),
    subgraphs: (parsed.subgraphs ?? []).map((subgraph) => {
      const geometry = storedSubgraphs.get(subgraph.id);
      if (!preserveGeometry || !geometry) return subgraph;
      const parsedData = architectureSubgraphGfxData(subgraph);
      const storedData = architectureSubgraphGfxData(geometry);
      return {
        ...subgraph,
        height: reprojectArchitectureDimension(
          parsedData?.intrinsicHeight,
          geometry.height,
          storedData?.intrinsicHeight,
        ),
        width: reprojectArchitectureDimension(
          parsedData?.intrinsicWidth,
          geometry.width,
          storedData?.intrinsicWidth,
        ),
        x: geometry.x,
        y: geometry.y,
      };
    }),
  } satisfies MermaidVisualModel;
}
