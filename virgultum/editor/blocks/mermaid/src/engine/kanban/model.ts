// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KanbanDiagnostic } from "./diagnostics.js";
import type { KanbanRange, KanbanSourceDocument } from "./source-document.js";
import type { SourceYaml } from "../source-yaml.js";

export type KanbanMetadata = {
  label?: unknown;
  icon?: unknown;
  assigned?: unknown;
  ticket?: unknown;
  priority?: unknown;
  [field: string]: unknown;
};
export type MermaidKanbanNode = {
  /** Neutral facade identity; never serialized into Mermaid source. */
  id: string;
  sourceKey: string;
  explicitId?: string;
  nativeId: string;
  label: string;
  order: number;
  indent: string;
  delimiter: readonly [string, string];
  labelRange?: KanbanRange;
  idRange?: KanbanRange;
  metadata: KanbanMetadata;
  metadataYaml?: SourceYaml;
  metadataRange?: KanbanRange;
  metadataInsertion: number;
  icon?: string;
  className?: string;
  decorationRanges: {
    field: "icon" | "class";
    range: KanbanRange;
    valueRange: KanbanRange;
    recordKey: string;
  }[];
  writable: boolean;
};
export type MermaidKanbanColumn = MermaidKanbanNode;
export type MermaidKanbanCard = MermaidKanbanNode & { columnId: string };
export type KanbanComment = {
  id: string;
  text: string;
  range: KanbanRange;
  indent: string;
  anchorId: string | null;
  affinity: "object" | "position";
  inline?: boolean;
};
export type MermaidKanbanModel = {
  cards: MermaidKanbanCard[];
  columns: MermaidKanbanColumn[];
  comments: KanbanComment[];
  sourceDocument: KanbanSourceDocument;
  diagnostics: KanbanDiagnostic[];
  ambiguous: boolean;
  /** The displayed objects belong to a prior valid source, never writable current anchors. */
  staleProjection?: boolean;
  headerId: string;
  diagramType: "kanban";
  sourceHash: string;
  version: 1;
};
