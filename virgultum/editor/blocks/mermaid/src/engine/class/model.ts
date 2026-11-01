// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ClassRange, ClassSourceDocument } from "./source-document.js";

export type MermaidClassMember = {
  id: string;
  classId: string;
  kind: "attribute" | "operation";
  visibility: "" | "+" | "-" | "#" | "~";
  name: string;
  type: string;
  parameters: string;
  returnType: string;
  classifier: "" | "static" | "abstract";
  raw: string;
  sourceForm: "block" | "short";
  range?: ClassRange;
  ranges: Partial<
    Record<
      | "visibility"
      | "name"
      | "type"
      | "parameters"
      | "returnType"
      | "classifier",
      ClassRange
    >
  >;
  precise: boolean;
};

export type MermaidClassNode = {
  annotations: string[];
  cssClasses: string[];
  genericType: string;
  id: string;
  interaction: string;
  kind: "class" | "lollipop-interface";
  label: string;
  members: MermaidClassMember[];
  namespaceId: string | null;
  order: number;
  sourceId: string;
  sourceKey: string;
  width: number;
  x: number;
  y: number;
};

export type ClassMarker =
  "none" | "arrow" | "inheritance" | "aggregation" | "composition" | "lollipop";
export type ClassLineStyle = "solid" | "dashed";
export type MermaidClassRelation = {
  sourceKey: string;
  fromSourceId: string;
  toSourceId: string;
  lineStyle: ClassLineStyle;
  fromMarker: ClassMarker;
  toMarker: ClassMarker;
  direction: "forward" | "backward" | "both" | "undirected";
  from: string;
  fromCardinality: string;
  id: string;
  kind: string;
  label: string;
  order: number;
  to: string;
  toCardinality: string;
};

export type MermaidClassNamespace = {
  sourceKey: string;
  explicit: boolean;
  id: string;
  label: string;
  order: number;
  parentId: string | null;
};

export type MermaidClassNote = {
  sourceKey: string;
  classId: string | null;
  id: string;
  namespaceId: string | null;
  order: number;
  text: string;
};

export type MermaidClassInteraction = {
  id: string;
  classId: string;
  kind: "link" | "callback";
  url: string;
  tooltip: string;
  target: "_self" | "_blank" | "_parent" | "_top";
  payload: string;
};
export type ClassStyleProperty = {
  name: string;
  value: string;
  range: ClassRange;
  valueRange: ClassRange;
};
export type MermaidClassStyle = {
  id: string;
  kind: "definition" | "inline" | "assignment";
  owners: string[];
  styles: string[];
  properties: ClassStyleProperty[];
};
export type MermaidClassComment = {
  id: string;
  text: string;
  anchorKind:
    "diagram" | "namespace" | "class" | "member" | "relation" | "note";
  anchorId?: string;
  position: "before" | "after" | "inside";
};
export type MermaidClassModel = {
  interactions: MermaidClassInteraction[];
  styles: MermaidClassStyle[];
  commentRecords: MermaidClassComment[];
  sourceDocument: ClassSourceDocument;
  accessibilityDescription: string;
  accessibilityTitle: string;
  comments: string[];
  diagramType: "classDiagram" | "classDiagram-v2";
  direction: "BT" | "LR" | "RL" | "TB";
  directives: string[];
  headerLine: string;
  hierarchicalNamespaces: boolean;
  namespaces: MermaidClassNamespace[];
  nodes: MermaidClassNode[];
  notes: MermaidClassNote[];
  relations: MermaidClassRelation[];
  sourceHash: string;
  styleStatements: string[];
  version: 1;
};
