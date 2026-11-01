import type { MermaidProductDiagramType } from "../../engine/product-types.js";
import type { MermaidVisualFamilyData } from "./gfx-family-data.js";
import { hashMermaidSource } from "../../utils.js";

export type MermaidVisualDirection = "BT" | "LR" | "RL" | "TB" | "TD";

export type MermaidVisualNodeShape =
  | "asymmetric"
  | "bang"
  | "bolt"
  | "bow-rect"
  | "brace"
  | "brace-r"
  | "braces"
  | "cherry-pick"
  | "circle"
  | "cloud"
  | "cross-circ"
  | "curv-trap"
  | "database"
  | "datastore"
  | "delay"
  | "diam"
  | "diamond"
  | "div-rect"
  | "doublecircle"
  | "doc"
  | "docs"
  | "f-circ"
  | "flag"
  | "flip-tri"
  | "fork"
  | "fr-circ"
  | "fr-rect"
  | "h-cyl"
  | "hexagon"
  | "hourglass"
  | "lean-l"
  | "lean-r"
  | "lin-cyl"
  | "lin-doc"
  | "lin-rect"
  | "notch-pent"
  | "notch-rect"
  | "odd"
  | "person"
  | "parallelogram"
  | "rect"
  | "rounded"
  | "sl-rect"
  | "sm-circ"
  | "stadium"
  | "st-rect"
  | "subroutine"
  | "tag-doc"
  | "tag-rect"
  | "text"
  | "trap-b"
  | "trap-t"
  | "trapezoid"
  | "tri"
  | "win-pane";

export type MermaidVisualEdgeStyle = "dotted" | "solid" | "thick";
export type MermaidVisualSemanticStyle =
  "accent" | "error" | "neutral" | "processing" | "success" | "warning";
export type MermaidVisualEdgeLinkType =
  | "arrow"
  | "bidirectional"
  | "circle"
  | "cross"
  | "dotted"
  | "open"
  | "reverse"
  | "thick";

export type MermaidVisualConnectorMode = "curve" | "orthogonal" | "straight";
export type MermaidVisualEdgeLabelPlacement = "bottom" | "center" | "top";
export type MermaidVisualEndpointPosition = readonly [number, number];
export type MermaidVisualEndpointMarker =
  | "arrow"
  | "bar"
  | "double-bar"
  | "bar-crow-foot"
  | "circle"
  | "circle-bar"
  | "circle-crow-foot"
  | "cross"
  | "crow-foot"
  | "diamond"
  | "hollow-circle"
  | "circle-cross"
  | "hollow-diamond"
  | "hollow-triangle"
  | "triangle"
  | "half-filled-top"
  | "half-filled-bottom"
  | "half-open-top"
  | "half-open-bottom"
  | "none";

export type MermaidVisualNodeDetailKind =
  | "field"
  | "metadata"
  | "operation"
  | "requirement-property"
  | "separator"
  | "endpoint";

// Semantic child rows for families such as Class/ER/Requirement. The current
// GFX materializer stores them on the parent shape; UI code may only promote
// them to selectable compartments once hit-testing, source readback and parent
// drag semantics are implemented against this contract.
export type MermaidVisualNodeDetail = {
  id: string;
  kind: MermaidVisualNodeDetailKind;
  label: string;
  order: number;
  sourceKey?: string;
  value?: string;
};

export type MermaidVisualTextAlign = "center" | "left" | "right";
export type MermaidVisualTextVerticalAlign = "bottom" | "center" | "top";

export type MermaidVisualNode = {
  /** Source-derived renderer rotation, in degrees; bounds include its painted extent. */
  rotate?: number;
  details?: MermaidVisualNodeDetail[];
  displayLabel?: string;
  familyData?: MermaidVisualFamilyData;
  id: string;
  label: string;
  labelEditable?: boolean;
  shape: MermaidVisualNodeShape;
  textAlign?: MermaidVisualTextAlign;
  textVerticalAlign?: MermaidVisualTextVerticalAlign;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MermaidVisualEdge = {
  /** Source-owned annotations at independent connector endpoints. */
  endpointLabels?: { readonly source: string; readonly target: string };
  displayLabel?: string;
  familyData?: MermaidVisualFamilyData;
  id: string;
  label: string;
  labelEditable?: boolean;
  labelPlacement?: MermaidVisualEdgeLabelPlacement;
  linkType?: MermaidVisualEdgeLinkType;
  mermaidId?: string;
  connectorMode?: MermaidVisualConnectorMode;
  source: string;
  sourceAttachment?: string;
  sourceMarker?: MermaidVisualEndpointMarker;
  sourcePortId?: string;
  sourcePosition?: MermaidVisualEndpointPosition;
  style: MermaidVisualEdgeStyle;
  target: string;
  targetAttachment?: string;
  targetMarker?: MermaidVisualEndpointMarker;
  targetPortId?: string;
  targetPosition?: MermaidVisualEndpointPosition;
};

export type MermaidVisualSubgraph = {
  displayLabel?: string;
  direction?: MermaidVisualDirection;
  familyData?: MermaidVisualFamilyData;
  height: number;
  id: string;
  nodeIds: string[];
  parentId?: string;
  title: string;
  width: number;
  x: number;
  y: number;
};

export type MermaidVisualModel = {
  accessibilityDescription?: string;
  accessibilityTitle?: string;
  diagramTitle?: string;
  direction: MermaidVisualDirection;
  diagramType: MermaidProductDiagramType;
  edges: MermaidVisualEdge[];
  familyData?: MermaidVisualFamilyData;
  nodes: MermaidVisualNode[];
  sourceAnnotations?: string[];
  sourcePreamble?: string[];
  styleStatements?: string[];
  subgraphs?: MermaidVisualSubgraph[];
  version: 1;
};

export function createMermaidGfxModelHash(model: MermaidVisualModel) {
  return hashMermaidSource(stableJson(model));
}

export function normalizeMermaidVisualModel(value: unknown) {
  const model = value as MermaidVisualModel | null | undefined;
  if (
    !model ||
    model.version !== 1 ||
    !Array.isArray(model.nodes) ||
    !Array.isArray(model.edges)
  ) {
    return null;
  }
  return model;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
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

export function resolveMermaidGfxEdgeEndpointPositions(edge: {
  readonly sourcePosition?: MermaidVisualEndpointPosition;
  readonly targetPosition?: MermaidVisualEndpointPosition;
}) {
  return {
    sourcePosition: edge.sourcePosition,
    targetPosition: edge.targetPosition,
  };
}
