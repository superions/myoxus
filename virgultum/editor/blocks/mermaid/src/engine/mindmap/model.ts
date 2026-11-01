// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MindmapDecoration,
  MindmapNodeSyntax,
  MermaidMindmapShape,
} from "./runtime-contract.js";
import type { MindmapSourceDocument } from "./source-document.js";
export type { MermaidMindmapShape } from "./runtime-contract.js";

export type MermaidMindmapNode = {
  sourceKey: string;
  syntaxId: string;
  runtimeId: number;
  syntax?: Pick<MindmapNodeSyntax, "syntaxId" | "labelForm" | "open" | "close">;
  decorations?: MindmapDecoration[];
  icon?: string;
  class?: string;
  depth: number;
  id: string;
  label: string;
  order: number;
  parentId: string | null;
  root: boolean;
  shape: MermaidMindmapShape;
  width: number;
  x: number;
  y: number;
};

export type MermaidMindmapModel = {
  diagramType: "mindmap";
  sourceDocument: MindmapSourceDocument;
  directives: string[];
  headerLine: string;
  nodes: MermaidMindmapNode[];
  sourceAnnotations: string[];
  sourceHash: string;
  version: 1;
};
