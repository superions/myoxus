// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ErSourceDocument, ErRange } from "./source-document.js";
export type ErKey = "PK" | "FK" | "UK";
export type ErDirection = "BT" | "LR" | "RL" | "TB";
export type ErCardinality =
  | "exactly-one"
  | "zero-or-one"
  | "one-or-many"
  | "zero-or-many"
  | "mermaid-parent";
export type MermaidErAttribute = {
  keys: ErKey[];
  optional: boolean;
  comment?: string;
  id: string;
  name: string;
  type: string;
};

export type MermaidErEntity = {
  sourceKey: string;
  scopeId: string | null;
  subgraphId: string | null;
  attributes: MermaidErAttribute[];
  cssClasses: string[];
  id: string;
  label: string;
  order: number;
};

export type MermaidErRelationship = {
  sourceKey: string;
  cardinalityA: ErCardinality;
  cardinalityB: ErCardinality;
  scopeId: string | null;
  from: string;
  fromCardinality: string;
  id: string;
  identification: "--" | "..";
  label: string;
  order: number;
  to: string;
  toCardinality: string;
};

export type MermaidErSubgraph = {
  sourceKey: string;
  id: string;
  label: string;
  parentId: string | null;
  direction?: ErDirection;
  members: string[];
  sourceMembers: string[];
  order: number;
  cssClasses: string[];
};
export type ErStyleProperty = {
  name: string;
  value: string;
  range: ErRange;
  valueRange: ErRange;
};
export type MermaidErStyle = {
  id: string;
  sourceKey: string;
  assignmentRange?: ErRange;
  removalRange?: ErRange;
  kind: "definition" | "inline" | "assignment";
  owners: string[];
  styles: string[];
  properties: ErStyleProperty[];
};
export type MermaidErComment = {
  id: string;
  text: string;
  anchorKind:
    "diagram" | "subgraph" | "entity" | "attribute" | "relation" | "record";
  anchorId?: string;
  position: "before" | "after" | "inside";
};
export type MermaidErModel = {
  sourceDocument: ErSourceDocument;
  subgraphs: MermaidErSubgraph[];
  styles: MermaidErStyle[];
  commentRecords: MermaidErComment[];
  accessibilityDescription: string;
  accessibilityTitle: string;
  comments: string[];
  diagramType: "erDiagram";
  direction: "BT" | "LR" | "RL" | "TB";
  directives: string[];
  entities: MermaidErEntity[];
  headerLine: string;
  relationships: MermaidErRelationship[];
  sourceHash: string;
  styleStatements: string[];
  version: 1;
};
