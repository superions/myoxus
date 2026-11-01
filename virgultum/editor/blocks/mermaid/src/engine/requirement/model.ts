// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequirementSourceDocument } from "./source-document.js";
import type { RequirementSourceDiagnostic } from "./diagnostics.js";
import type { RequirementPropertyName } from "./runtime-contract.js";

export type MermaidRequirementNode = {
  sourceKey?: string;
  propertyKeys?: Partial<Record<RequirementPropertyName, string[]>>;
  classes?: string[];
  cssStyles?: string[];
  id: string;
  name: string;
  order: number;
  requirementId: string;
  requirementType: string;
  risk: string;
  text: string;
  verifyMethod: string;
  width: number;
  x: number;
  y: number;
};

export type MermaidRequirementElement = {
  sourceKey?: string;
  propertyKeys?: Partial<Record<RequirementPropertyName, string[]>>;
  classes?: string[];
  cssStyles?: string[];
  docRef: string;
  elementType: string;
  id: string;
  name: string;
  order: number;
  width: number;
  x: number;
  y: number;
};

export type MermaidRequirementRelation = {
  sourceKey?: string;
  sourceForm?: "left" | "right";
  fromId?: string;
  toId?: string;
  from: string;
  id: string;
  kind: string;
  order: number;
  to: string;
};

export type MermaidRequirementModel = {
  sourceDocument?: RequirementSourceDocument;
  diagnostics?: RequirementSourceDiagnostic[];
  direction?: "TB" | "BT" | "LR" | "RL";
  accTitle?: string;
  accDescr?: string;
  diagramType: "requirementDiagram";
  directives: string[];
  elements: MermaidRequirementElement[];
  headerLine: string;
  sourceAnnotations: string[];
  relations: MermaidRequirementRelation[];
  requirements: MermaidRequirementNode[];
  sourceHash: string;
  version: 1;
};
