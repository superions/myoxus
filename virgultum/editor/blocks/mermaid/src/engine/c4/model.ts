// SPDX-License-Identifier: AGPL-3.0-or-later

import type { C4SourceDocument } from "./source-document.js";

export type C4FieldValue = string | number | { text: string };
export type C4FieldProvider = {
  sourceKey: string;
  argumentIndex?: number;
  form: "value" | "empty" | "omitted" | "injected";
};
export type C4SelectionBinding = {
  selectionId: string;
  sourceKeys: string[];
  category: "element" | "boundary" | "relationship";
  identity: string;
};
export type C4ResolvedGroup = {
  selectionId: string;
  sourceKeys: string[];
  declarationKey: string;
  fields: Record<string, C4FieldValue>;
  providers: Record<string, C4FieldProvider>;
};
export type C4CallOccurrence = {
  sourceKey: string;
  kind: string;
  category: "element" | "boundary" | "relationship" | "update";
  callArguments: MermaidC4Argument[];
  scopeKeys: string[];
  scopeAliases: string[];
  order: number;
  applied: boolean;
  selectionId?: string;
  providedFields: string[];
  effectiveFields: string[];
  shadowedFields: string[];
};

export type MermaidC4Direction = "BT" | "LR" | "RL" | "TB";

export type MermaidC4Argument = {
  /** Distinguishes the native empty-key object $="value" from a positional string. */
  named?: true;
  key: string;
  value: string;
};

type C4ResolvedDraft = {
  /** Drafts have no source provider until their first declaration is written. */
  resolution?: C4ResolvedGroup;
};

export type MermaidC4Element = C4ResolvedDraft & {
  alias: string;
  boundaryId: string;
  callArguments: MermaidC4Argument[];
  description: string;
  id: string;
  kind: string;
  label: string;
  link: string;
  order: number;
  sprite: string;
  tags: string;
  technology: string;
  width: number;
  x: number;
  y: number;
};

export type MermaidC4Boundary = C4ResolvedDraft & {
  alias: string;
  nodeType?: C4FieldValue;
  boundaryType: string;
  callArguments: MermaidC4Argument[];
  description: string;
  height: number;
  id: string;
  kind: string;
  label: string;
  link: string;
  order: number;
  parentId: string;
  sprite: string;
  tags: string;
  width: number;
  x: number;
  y: number;
};

export type MermaidC4Relationship = C4ResolvedDraft & {
  callArguments: MermaidC4Argument[];
  description: string;
  from: string;
  id: string;
  /** RelIndex Source text; native rendering ignores it when numbering Dynamic pairs. */
  index: string | null;
  dynamicStep?: number;
  kind: string;
  label: string;
  link: string;
  order: number;
  sprite: string;
  tags: string;
  technology: string;
  to: string;
};

export type MermaidC4UpdateStatement = {
  /** Existing update occurrences keep their physical owner through deletion/reorder. */
  sourceKey?: string;
  callArguments: MermaidC4Argument[];
  kind: "UpdateElementStyle" | "UpdateLayoutConfig" | "UpdateRelStyle";
  order: number;
};

export type MermaidC4Model = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  boundaries: MermaidC4Boundary[];
  diagramType: "c4";
  direction: MermaidC4Direction;
  directives: string[];
  elements: MermaidC4Element[];
  headerLine: string;
  layoutBoundaryInRow: number;
  layoutShapeInRow: number;
  sourceDocument: C4SourceDocument;
  occurrences: C4CallOccurrence[];
  relationships: MermaidC4Relationship[];
  sourceHash: string;
  title: string;
  updateStatements: MermaidC4UpdateStatement[];
  version: 1;
};
