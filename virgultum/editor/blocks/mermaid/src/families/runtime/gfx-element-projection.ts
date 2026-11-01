// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bound } from "@virgultum/global/gfx";
import {
  ConnectorLabelOffsetAnchor,
  DEFAULT_ROUGHNESS,
  LineWidth,
  ShapeType,
  StrokeStyle,
  TextAlign,
} from "@virgultum/model";

import {
  fitMermaidGfxLabelFontSize,
  measureMermaidGfxText,
  mermaidGfxLabelPadding,
  mermaidGfxTypographyForNode,
  resolveMermaidGfxTheme,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import type {
  MermaidGfxDetailElementProjection,
  MermaidGfxConnectorElementProjection,
  MermaidGfxNodeElementProjection,
} from "./gfx-family-hooks-contract.js";
import { getMermaidGfxFamilyHooks } from "./gfx-family-hooks-registry.js";
import { serializeMermaidVisualFamilyData } from "./gfx-family-data.js";
import {
  MERMAID_GFX_DETAIL_HEADER_HEIGHT,
  MERMAID_GFX_DETAIL_INSET,
  MERMAID_GFX_DETAIL_ROW_HEIGHT,
} from "./gfx-detail-projection.js";
import {
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_DETAIL_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
  MERMAID_GFX_TITLE_HEIGHT,
  MERMAID_GFX_TITLE_BAND_HEIGHT,
  MERMAID_GFX_TITLE_ROLE,
} from "./gfx-element-roles.js";
import type {
  MermaidVisualDirection,
  MermaidVisualEdge,
  MermaidVisualEdgeLabelPlacement,
  MermaidVisualEndpointPosition,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
  MermaidVisualSubgraph,
} from "./gfx-model.js";
import { resolveMermaidGfxEdgeEndpointPositions } from "./gfx-model.js";

export type MermaidGfxElement = {
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: string;
  fontWeight?: string;
  id: string;
  props?: Record<string, unknown>;
  radius?: number;
  shapeType?: string;
  source?: { id?: string; position?: readonly unknown[] };
  strokeStyle?: string;
  strokeWidth?: number;
  target?: { id?: string; position?: readonly unknown[] };
  text?: { toString: () => string } | string;
  textAlign?: string;
  textDisplay?: boolean;
  textVerticalAlign?: string;
  type?: string;
  xywh?: string;
  yMap?: {
    get: (key: string) => unknown;
  };
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function serializeNodeDetailsMeta(
  details: readonly MermaidVisualNodeDetail[] | undefined,
) {
  return details?.length ? stableJson(details) : "";
}

function shouldDisplayMermaidNodeText(node: MermaidVisualNode) {
  // Empty helper nodes are geometry-only anchors. Some GFX shapes fall back to
  // their model id when text is enabled, so disable text at the projection
  // boundary instead of letting internal anchor ids leak into diagrams.
  return (node.displayLabel ?? node.label).trim().length > 0;
}

const MERMAID_GFX_TITLE_INSET = 12;

export function getMermaidGfxTitleBandHeight(
  model: MermaidVisualModel | null | undefined,
) {
  return (
    MERMAID_GFX_TITLE_BAND_HEIGHT +
    (model
      ? (getMermaidGfxFamilyHooks(model)?.diagramTitleTopMargin?.(model) ?? 0)
      : 0)
  );
}
export function toMermaidDiagramTitleElementProps(
  title: string,
  ownerBound: Bound,
  model?: MermaidVisualModel,
) {
  const topMargin = model
    ? (getMermaidGfxFamilyHooks(model)?.diagramTitleTopMargin?.(model) ?? 0)
    : 0;
  const gfxTheme = resolveMermaidGfxProjectionTheme();
  return {
    color: gfxTheme.textColor,
    fillColor: gfxTheme.surfaceColor,
    filled: false,
    fontFamily: gfxTheme.typography.fontFamily,
    fontSize: gfxTheme.typography.fontSize + 4,
    fontStyle: gfxTheme.typography.fontStyle,
    fontWeight: "600",
    mermaidDiagramTitle: title,
    mermaidNodeSelectable: false,
    mermaidRole: MERMAID_GFX_TITLE_ROLE,
    radius: 0,
    rotate: 0,
    roughness: DEFAULT_ROUGHNESS,
    seed: 42,
    shapeStyle: "General",
    shapeType: ShapeType.Rect,
    strokeColor: gfxTheme.borderColor,
    strokeStyle: StrokeStyle.None,
    strokeWidth: 0,
    text: title,
    textAlign: TextAlign.Center,
    textDisplay: true,
    textVerticalAlign: "center" as const,
    xywh: new Bound(
      ownerBound.x + MERMAID_GFX_TITLE_INSET,
      ownerBound.y + topMargin,
      Math.max(1, ownerBound.w - MERMAID_GFX_TITLE_INSET * 2),
      MERMAID_GFX_TITLE_HEIGHT,
    ).serialize(),
  };
}

export function toMermaidShapeElementProps(
  node: MermaidVisualNode,
  ownerBound: Bound,
  diagramDirection: MermaidVisualDirection | undefined,
  diagramTitle: string | undefined,
  elementProjection: MermaidGfxNodeElementProjection,
) {
  const {
    denseLabel = false,
    selectable = true,
    radius,
    shapeType,
    ...projectedElementStyle
  } = elementProjection;
  const gfxTheme = resolveMermaidGfxProjectionTheme();
  const text = node.displayLabel ?? node.label;
  const projectedFontFamily =
    elementProjection.fontFamily ?? gfxTheme.typography.fontFamily;
  const projectedFontSize =
    elementProjection.fontSize ??
    fitMermaidGfxLabelFontSize(text, node, elementProjection, gfxTheme);
  const projectedFontStyle =
    elementProjection.fontStyle ?? gfxTheme.typography.fontStyle;
  const projectedFontWeight =
    elementProjection.fontWeight ?? gfxTheme.typography.fontWeight;
  const projectedPadding = mermaidGfxLabelPadding(gfxTheme);
  return {
    color: gfxTheme.textColor,
    fillColor: gfxTheme.surfaceColor,
    filled: true,
    fontFamily: projectedFontFamily,
    fontSize: projectedFontSize,
    fontStyle: projectedFontStyle,
    fontWeight: projectedFontWeight,
    mermaidDiagramDirection: diagramDirection ?? "",
    mermaidDiagramTitle: diagramTitle ?? "",
    mermaidNodeFamilyData: serializeMermaidVisualFamilyData(node.familyData),
    mermaidNodeDetails: serializeNodeDetailsMeta(node.details),
    mermaidNodeDisplayLabel: node.displayLabel ?? node.label,
    mermaidNodeDenseLabel: denseLabel,
    mermaidContour: [],
    mermaidNodeId: node.id,
    mermaidNodeLabel: node.label,
    mermaidNodeLabelEditable: node.labelEditable ?? true,
    mermaidNodeSelectable: selectable,
    mermaidNodeShape: node.shape,
    mermaidRole: MERMAID_GFX_NODE_ROLE,
    radius,
    rotate: node.rotate ?? 0,
    roughness: DEFAULT_ROUGHNESS,
    seed: 42,
    shapeStyle: "General",
    shapeType,
    strokeColor: gfxTheme.borderColor,
    strokeStyle: StrokeStyle.Solid,
    strokeWidth: LineWidth.Two,
    text,
    textAlign: node.textAlign ?? "center",
    textDisplay: shouldDisplayMermaidNodeText(node),
    textVerticalAlign: node.textVerticalAlign ?? "center",
    padding: projectedPadding,
    xywh: new Bound(
      ownerBound.x + node.x,
      ownerBound.y + node.y,
      node.width,
      node.height,
    ).serialize(),
    ...projectedElementStyle,
  };
}

export function mermaidVisualNodeDetailElementId(
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
) {
  return `${node.id}::detail::${detail.id}`;
}

/** Semantic rows and derived endpoint annotations share the existing child-shape
 * lifecycle. Endpoint anchors are transient projection geometry, never nodes in
 * the Source-owned graph. */
export function getMermaidVisualNodeDetailElementEntries(
  visualModel: Pick<MermaidVisualModel, "nodes"> &
    Partial<Pick<MermaidVisualModel, "edges" | "subgraphs">>,
) {
  const rows = visualModel.nodes.flatMap((node) =>
    [...(node.details ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((detail, rowIndex) => ({
        detail,
        elementId: mermaidVisualNodeDetailElementId(node, detail),
        node,
        rowIndex,
        edge: undefined as MermaidVisualEdge | undefined,
        projection: undefined as MermaidGfxDetailElementProjection | undefined,
      })),
  );
  const theme = resolveMermaidGfxProjectionTheme(),
    padding = theme.typography.lineHeight / 2;
  for (const edge of visualModel.edges ?? []) {
    if (!edge.endpointLabels) continue;
    const endpoints = [...visualModel.nodes, ...(visualModel.subgraphs ?? [])],
      source = endpoints.find((n) => n.id === edge.source),
      target = endpoints.find((n) => n.id === edge.target);
    if (!source || !target) continue;
    for (const side of ["source", "target"] as const) {
      const label = edge.endpointLabels[side];
      if (!label) continue;
      const owner = side === "source" ? source : target,
        other = side === "source" ? target : source;
      const explicit =
        side === "source" ? edge.sourcePosition : edge.targetPosition;
      const dx = other.x + other.width / 2 - owner.x - owner.width / 2,
        dy = other.y + other.height / 2 - owner.y - owner.height / 2;
      const position =
        explicit ??
        (Math.abs(dx) >= Math.abs(dy)
          ? [dx >= 0 ? 1 : 0, 0.5]
          : [0.5, dy >= 0 ? 1 : 0]);
      const measured = measureMermaidGfxText(label, theme.typography),
        width = measured.width + padding * 2,
        height = measured.height + padding;
      // Labels must sit outside the attached compartment. A top/bottom port
      // needs a vertical outward offset; source/target alone does not tell us
      // which side of the class is outside.
      const verticalPort = position[0] !== 0 && position[0] !== 1;
      const left =
        owner.x +
        owner.width * position[0]! +
        (verticalPort
          ? padding
          : position[0] === 1
            ? padding
            : -width - padding);
      const top =
        owner.y +
        owner.height * position[1]! +
        (verticalPort
          ? position[1] === 0
            ? -height - padding
            : padding
          : side === "source"
            ? -height - padding
            : padding);
      const node: MermaidVisualNode = {
        id: edge.id,
        label: "",
        shape: "text",
        x: left,
        y: top,
        width,
        height,
      };
      const detail: MermaidVisualNodeDetail = {
        id: `${edge.id}:cardinality:${side}`,
        kind: "endpoint",
        label,
        order: 0,
      };
      rows.push({
        detail,
        elementId: mermaidVisualNodeDetailElementId(node, detail),
        node,
        rowIndex: 0,
        edge,
        projection: {
          offsetY: 0,
          relativeBound: { x: 0, y: 0, width, height },
          text: label,
          color: theme.textColor,
          fillColor: theme.surfaceColor,
          fontSize: theme.typography.fontSize,
          fontWeight: theme.typography.fontWeight,
          filled: true,
          strokeWidth: 0,
          strokeStyle: StrokeStyle.None,
          padding: [0, 0],
          selectable: true,
        },
      });
    }
  }
  return rows;
}

export function getMermaidVisualNodeDetailElementCount(
  visualModel: Pick<MermaidVisualModel, "nodes"> &
    Partial<Pick<MermaidVisualModel, "edges">>,
) {
  return getMermaidVisualNodeDetailElementEntries(visualModel).length;
}

export function toMermaidNodeDetailElementProps({
  detail,
  projection,
  ownerBound,
  node,
  rowIndex,
}: {
  detail: MermaidVisualNodeDetail;
  projection: MermaidGfxDetailElementProjection;
  ownerBound: Bound;
  node: MermaidVisualNode;
  rowIndex?: number;
}) {
  const {
    offsetY,
    relativeBound,
    text,
    textAlign = "left",
    textVerticalAlign = "center",
    ...elementStyle
  } = projection;
  const y =
    ownerBound.y +
    node.y +
    MERMAID_GFX_DETAIL_HEADER_HEIGHT +
    (rowIndex ?? detail.order) * MERMAID_GFX_DETAIL_ROW_HEIGHT +
    offsetY;
  return {
    filled: true,
    mermaidDetailId: detail.id,
    mermaidDetailKind: detail.kind,
    mermaidDetailLabel: detail.label,
    mermaidDetailDisplayLabel: text,
    mermaidDetailOrder: detail.order,
    mermaidDetailOwnerNodeId: node.id,
    mermaidDetailSourceKey: detail.sourceKey ?? "",
    mermaidDetailValue: detail.value ?? "",
    mermaidContour: [],
    mermaidNodeId: node.id,
    mermaidRole: MERMAID_GFX_DETAIL_ROLE,
    radius: 0,
    rotate: 0,
    roughness: DEFAULT_ROUGHNESS,
    seed: 42,
    shapeStyle: "General",
    shapeType: ShapeType.Rect,
    strokeStyle: StrokeStyle.Solid,
    text,
    textAlign,
    textDisplay: true,
    textVerticalAlign,
    xywh: relativeBound
      ? new Bound(
          ownerBound.x + node.x + relativeBound.x,
          ownerBound.y + node.y + relativeBound.y,
          relativeBound.width,
          relativeBound.height,
        ).serialize()
      : new Bound(
          ownerBound.x + node.x + MERMAID_GFX_DETAIL_INSET,
          y,
          Math.max(
            MERMAID_GFX_DETAIL_ROW_HEIGHT,
            node.width - MERMAID_GFX_DETAIL_INSET * 2,
          ),
          MERMAID_GFX_DETAIL_ROW_HEIGHT,
        ).serialize(),
    ...elementStyle,
  };
}

export function toMermaidSubgraphElementProps(
  subgraph: MermaidVisualSubgraph,
  ownerBound: Bound,
  elementProjection: MermaidGfxNodeElementProjection,
) {
  const {
    radius,
    subgraphHeaderHeight = 0,
    selectable = true,
    shapeType,
    ...projectedElementStyle
  } = elementProjection;
  const gfxTheme = resolveMermaidGfxProjectionTheme();
  const projectedFontFamily =
    elementProjection.fontFamily ?? gfxTheme.typography.fontFamily;
  const projectedFontSize =
    elementProjection.fontSize ?? gfxTheme.typography.fontSize;
  const projectedFontStyle =
    elementProjection.fontStyle ?? gfxTheme.typography.fontStyle;
  const projectedFontWeight =
    elementProjection.fontWeight ?? gfxTheme.typography.fontWeight;
  const projectedPadding = mermaidGfxLabelPadding(gfxTheme);
  return {
    color: gfxTheme.textColor,
    fillColor: gfxTheme.surfaceColor,
    filled: true,
    fontFamily: projectedFontFamily,
    fontSize: projectedFontSize,
    fontStyle: projectedFontStyle,
    fontWeight: projectedFontWeight,
    mermaidRole: MERMAID_GFX_SUBGRAPH_ROLE,
    mermaidSubgraphFamilyData: serializeMermaidVisualFamilyData(
      subgraph.familyData,
    ),
    mermaidSubgraphDisplayLabel: subgraph.displayLabel ?? subgraph.title,
    mermaidSubgraphDirection: subgraph.direction ?? "",
    mermaidSubgraphId: subgraph.id,
    mermaidSubgraphSelectable: selectable,
    mermaidSubgraphTitle: subgraph.title,
    mermaidSubgraphHeaderHeight: subgraphHeaderHeight,
    radius,
    rotate: 0,
    roughness: DEFAULT_ROUGHNESS,
    seed: 42,
    shapeStyle: "General",
    shapeType,
    strokeColor: gfxTheme.borderColor,
    strokeStyle: StrokeStyle.Solid,
    strokeWidth: LineWidth.Two,
    text: subgraph.displayLabel ?? subgraph.title,
    textAlign: "center",
    textDisplay: subgraph.title.trim().length > 0,
    textVerticalAlign: "top",
    padding: projectedPadding,
    xywh: new Bound(
      ownerBound.x + subgraph.x,
      ownerBound.y + subgraph.y,
      subgraph.width,
      subgraph.height,
    ).serialize(),
    ...projectedElementStyle,
  };
}

function connectorLabelOffsetAnchorForPlacement(
  placement: MermaidVisualEdgeLabelPlacement,
) {
  if (placement === "top") return ConnectorLabelOffsetAnchor.Top;
  if (placement === "bottom") return ConnectorLabelOffsetAnchor.Bottom;
  return ConnectorLabelOffsetAnchor.Center;
}

export function semanticMermaidEdgeLabelPlacementForEndpoints({
  sourcePosition,
  targetPosition,
}: {
  sourcePosition?: MermaidVisualEndpointPosition;
  targetPosition?: MermaidVisualEndpointPosition;
}): MermaidVisualEdgeLabelPlacement {
  return sourcePosition?.[0] === 0.5 && targetPosition?.[0] === 0.5
    ? "center"
    : "top";
}

export function toMermaidConnectorElementProps(
  edge: MermaidVisualEdge,
  idMap: ReadonlyMap<string, string>,
  labelXYWH: readonly [number, number, number, number] | undefined,
  elementProjection: MermaidGfxConnectorElementProjection,
) {
  const gfxTheme = resolveMermaidGfxProjectionTheme();
  const {
    color: projectedLabelColor,
    fontFamily: projectedLabelFontFamily,
    fontSize: projectedLabelFontSize,
    fontStyle: projectedLabelFontStyle,
    fontWeight: projectedLabelFontWeight,
    labelOffsetDistance,
    labelLineHeight: _labelLineHeight,
    labelTextAlign,
    labelObstacleKeys,
    routingObstacleKeys,
    routingObstacleRegions,
    ...projectedConnectorStyle
  } = elementProjection;
  const sourceId = idMap.get(edge.sourceAttachment ?? edge.source);
  const targetId = idMap.get(edge.targetAttachment ?? edge.target);
  if (!sourceId || !targetId) {
    throw new Error(`Mermaid connector endpoint missing: ${edge.id}`);
  }

  const labelPlacement = edge.labelPlacement ?? "center";
  const labelOffsetAnchor =
    connectorLabelOffsetAnchorForPlacement(labelPlacement);
  const { sourcePosition, targetPosition } =
    resolveMermaidGfxEdgeEndpointPositions(edge);

  return {
    ...(labelObstacleKeys
      ? {
          labelObstacleIds: labelObstacleKeys.flatMap((key) => {
            const id = idMap.get(key);
            return id ? [id] : [];
          }),
        }
      : {}),
    ...(routingObstacleRegions
      ? {
          routingObstacleRegions: Object.fromEntries(
            Object.entries(routingObstacleRegions).flatMap(([key, region]) => {
              const id = idMap.get(key);
              return id ? [[id, region]] : [];
            }),
          ),
        }
      : {}),
    ...(routingObstacleKeys
      ? {
          routingObstacleIds: routingObstacleKeys.flatMap((key) => {
            const id = idMap.get(key);
            return id ? [id] : [];
          }),
        }
      : {}),
    labelDisplay: Boolean(edge.displayLabel ?? edge.label),
    labelConstraints: {
      hasMaxWidth: false,
      maxWidth: labelXYWH?.[2] ?? 0,
    },
    mermaidEdgeId: edge.id,
    mermaidEdgeFamilyData: serializeMermaidVisualFamilyData(edge.familyData),
    mermaidEdgeDisplayLabel: edge.displayLabel ?? edge.label,
    mermaidEdgeLabel: edge.label,
    mermaidEdgeLabelEditable: edge.labelEditable ?? true,
    mermaidEdgeLabelPlacement: edge.labelPlacement ?? "",
    mermaidEdgeLinkType: edge.linkType ?? "arrow",
    mermaidEdgeMermaidId: edge.mermaidId ?? "",
    mermaidEdgeSemanticSource: edge.source,
    mermaidEdgeSemanticTarget: edge.target,
    mermaidEdgeSourceAttachment: edge.sourceAttachment ?? "",
    mermaidEdgeSourceMarker: edge.sourceMarker ?? "",
    mermaidEdgeSourcePortId: edge.sourcePortId ?? "",
    mermaidEdgeTargetAttachment: edge.targetAttachment ?? "",
    mermaidEdgeTargetMarker: edge.targetMarker ?? "",
    mermaidEdgeTargetPortId: edge.targetPortId ?? "",
    mermaidEdgeStyle: edge.style,
    mermaidEdgeConnectorMode: edge.connectorMode ?? "",
    mermaidRole: MERMAID_GFX_EDGE_ROLE,
    labelOffset: {
      anchor: labelOffsetAnchor,
      distance: labelOffsetDistance ?? 0.5,
    },
    labelStyle: {
      color: projectedLabelColor ?? gfxTheme.textColor,
      fontFamily: projectedLabelFontFamily ?? gfxTheme.typography.fontFamily,
      fontSize: projectedLabelFontSize ?? gfxTheme.typography.fontSize,
      fontStyle: projectedLabelFontStyle ?? gfxTheme.typography.fontStyle,
      fontWeight: projectedLabelFontWeight ?? gfxTheme.typography.fontWeight,
      textAlign: labelTextAlign ?? TextAlign.Center,
    },
    // This object is also the complete in-place update projection. Preserve
    // empty values so removing a semantic label clears retained connector
    // text and its label bound instead of leaving stale GFX chrome.
    labelXYWH,
    text: edge.displayLabel ?? edge.label,
    // Families may opt into straight or curved connectors for their semantic
    // geometry; orthogonal remains the neutral readable default.
    rough: false,
    roughness: DEFAULT_ROUGHNESS,
    rotate: 0,
    // Family adapters resolve semantic attachment geometry before projection.
    source: {
      id: sourceId,
      ...(sourcePosition ? { position: sourcePosition } : {}),
    },
    stroke: gfxTheme.borderColor,
    target: {
      id: targetId,
      ...(targetPosition ? { position: targetPosition } : {}),
    },
    ...projectedConnectorStyle,
  };
}

export function resolveMermaidConnectorLabelXYWH({
  edge,
  elementProjection,
  ownerBound,
  labelOffset = { x: 0, y: 0 },
  visualModel,
}: {
  edge: MermaidVisualEdge;
  elementProjection?: Pick<
    MermaidGfxConnectorElementProjection,
    | "fontFamily"
    | "fontSize"
    | "fontStyle"
    | "fontWeight"
    | "labelLineHeight"
    | "labelOffsetDistance"
  >;
  ownerBound: Bound;
  labelOffset?: { readonly x: number; readonly y: number };
  visualModel: Pick<MermaidVisualModel, "nodes" | "subgraphs">;
}): [number, number, number, number] | undefined {
  if (!(edge.displayLabel ?? edge.label).trim()) return undefined;
  const bounds = new Map<
    string,
    { height: number; width: number; x: number; y: number }
  >();
  for (const node of visualModel.nodes) {
    bounds.set(node.id, node);
  }
  for (const subgraph of visualModel.subgraphs ?? []) {
    bounds.set(subgraph.id, {
      height: subgraph.height,
      width: subgraph.width,
      x: subgraph.x,
      y: subgraph.y,
    });
  }
  const source = bounds.get(edge.sourceAttachment ?? edge.source);
  const target = bounds.get(edge.targetAttachment ?? edge.target);
  if (!source || !target) return undefined;

  const sourceCenterX =
    ownerBound.x + source.x + source.width * (edge.sourcePosition?.[0] ?? 0.5);
  const sourceCenterY =
    ownerBound.y + source.y + source.height * (edge.sourcePosition?.[1] ?? 0.5);
  const targetCenterX =
    ownerBound.x + target.x + target.width * (edge.targetPosition?.[0] ?? 0.5);
  const targetCenterY =
    ownerBound.y + target.y + target.height * (edge.targetPosition?.[1] ?? 0.5);
  const visibleLabel = edge.displayLabel ?? edge.label;
  const theme = resolveMermaidGfxTheme();
  const typography = mermaidGfxTypographyForNode(
    elementProjection ?? {},
    theme,
  );
  if (elementProjection?.labelLineHeight)
    typography.lineHeight = elementProjection.labelLineHeight;
  const measuredLabel = measureMermaidGfxText(visibleLabel, typography);
  // Connector labels sit directly on the rendered path. Shape-sized padding
  // makes the canvas renderer clip a long, unexplained hole out of short edge
  // segments. Keep only a typography-relative reading clearance around the
  // measured text; the connector renderer adds its own stroke clearance.
  // The connector renderer reserves its own inline editing inset inside this
  // persisted box. A quarter line-height leaves short labels such as `yes`
  // only their measured glyph width after that inset and wraps the final
  // character on canvas. Keep one half line-height on each side so the
  // projection remains a single readable line without imposing a fixed width.
  const inlineClearance = typography.lineHeight / 2;
  const blockClearance = typography.lineHeight / 8;
  const width = measuredLabel.width + inlineClearance * 2;
  const height = measuredLabel.height + blockClearance * 2;
  const distance = elementProjection?.labelOffsetDistance ?? 0.5;
  const centerX =
    sourceCenterX + (targetCenterX - sourceCenterX) * distance + labelOffset.x;
  // Native connector labels need an initial box before the connector manager
  // can keep them attached to the generated path. Place the first projection
  // just above the semantic edge center so labels are readable immediately
  // after source materialization.
  const centerY =
    (sourceCenterY + targetCenterY) / 2 +
    (edge.labelPlacement === "top"
      ? -height
      : edge.labelPlacement === "bottom"
        ? height
        : -height * 0.75) +
    labelOffset.y;

  return [centerX - width / 2, centerY - height / 2, width, height];
}

export function mermaidGfxEdgeLabelOffset(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.edgeLabelOffset?.(model, edge) ?? {
      x: 0,
      y: 0,
    }
  );
}

export function isMermaidGfxEdgeReconnectable(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge | null | undefined,
) {
  if (!edge) return false;
  return (
    getMermaidGfxFamilyHooks(model)?.edgeReconnectable?.(model, edge) ?? true
  );
}
