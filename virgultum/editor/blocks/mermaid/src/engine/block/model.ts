// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidBlockShape =
  | "rect"
  | "rounded"
  | "circle"
  | "doublecircle"
  | "subroutine"
  | "database"
  | "stadium"
  | "hexagon"
  | "lean-r"
  | "lean-l"
  | "trap-b"
  | "trap-t"
  | "asymmetric"
  | "diamond"
  | "odd";
export type MermaidBlockEdgeStyle = "dotted" | "solid" | "thick";

export type MermaidBlockDirection =
  "down" | "left" | "right" | "up" | "x" | "y";

export type MermaidBlockEndpointMarker = "arrow" | "circle" | "cross" | "none";

export type MermaidBlockNodeSyntax =
  | "asymmetric"
  | "bare"
  | "block-arrow"
  | "circle"
  | "custom"
  | "cylinder"
  | "diamond"
  | "doublecircle"
  | "hexagon"
  | "lean-left"
  | "lean-right"
  | "rectangle"
  | "rounded"
  | "stadium"
  | "subroutine"
  | "trapezoid"
  | "trapezoid-inverted";

/** Effective fields refer to their actual declaring endpoint. A later occurrence
 * can change label/type without acquiring the first occurrence's grid placement. */
export type BlockFieldBinding = { sourceKey: string; endpoint: number };
export type MermaidBlockNode = {
  sourceKey: string;
  recordKeys: string[];
  providers: {
    label: BlockFieldBinding;
    shape: BlockFieldBinding;
    span: BlockFieldBinding;
    directions: BlockFieldBinding;
  };
  directions: MermaidBlockDirection[];
  id: string;
  label: string;
  order: number;
  parentId: string;
  parentKey: string | null;
  gridPlacement: boolean;
  shape: MermaidBlockShape;
  sourceClose: string;
  sourceOpen: string;
  span: number;
  syntax: MermaidBlockNodeSyntax;
  classes: string[];
  styles: string[];
};
export type MermaidBlockGroup = MermaidBlockNode & {
  columns: number;
  columnsKey?: string;
  explicitId: boolean;
  bodyKey: string;
};
export type MermaidBlockSpace = {
  sourceKey: string;
  id: string;
  order: number;
  parentId: string;
  parentKey: string | null;
  span: number;
};
export type MermaidBlockEdge = {
  sourceKey: string;
  from: string;
  id: string;
  token: string;
  startToken?: string;
  labelSource: string;
  invisible: boolean;
  label: string;
  order: number;
  parentKey: string | null;
  sourceMarker: MermaidBlockEndpointMarker;
  style: MermaidBlockEdgeStyle;
  targetMarker: MermaidBlockEndpointMarker;
  to: string;
  resolved: boolean;
};
export type MermaidBlockStyleStatement = {
  sourceKey: string;
  kind: "class" | "classDef" | "style";
  order: number;
  parentKey: string | null;
  targets: string;
  value: string;
};
export type BlockComment = {
  sourceKey: string;
  text: string;
  parentKey: string | null;
  anchorKey?: string;
  position: "before" | "after" | "inline";
};
export type MermaidBlockDiagramModel = {
  sourceDocument: import("./source-document.js").BlockSourceDocument;
  diagnostics: import("./diagnostics.js").BlockDiagnostic[];
  config: import("./config.js").BlockDiagramConfig;
  columns: number;
  columnsKey?: string;
  diagramType: "block";
  directives: string[];
  edges: MermaidBlockEdge[];
  groups: MermaidBlockGroup[];
  headerLine: string;
  nodes: MermaidBlockNode[];
  comments: BlockComment[];
  sourceHash: string;
  spaces: MermaidBlockSpace[];
  styleStatements: MermaidBlockStyleStatement[];
  version: 1;
};
