// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PacketRange, PacketSourceDocument } from "./source-document.js";
import type { readPacketConfig } from "./config.js";

/** Diagnostic copy is resolved on consumption so cached history projections
 * follow the active locale without reparsing or changing source identity. */
export type MermaidPacketDiagnostic = {
  code: "syntax" | "precision" | "config" | "materialization";
  line: number;
  message: string;
};

export type MermaidPacketField = {
  sourceKey?: string;
  sourceForm: "single" | "range" | "count";
  statementRange?: PacketRange;
  numberRange?: PacketRange;
  startRange?: PacketRange;
  endRange?: PacketRange;
  labelRange?: PacketRange;
  quote?: "'" | '"';
  indent?: string;
  eol?: string;
  separator?: string;
  endBit: number;
  id: string;
  label: string;
  order: number;
  startBit: number;
  width: number;
};

export type MermaidPacketComment = {
  sourceKey?: string;
  range?: PacketRange;
  text?: string;
  indent?: string;
  affinity?: "object" | "position";
  anchorId?: string;
  anchorKind:
    | "accessibility-description"
    | "accessibility-title"
    | "diagram"
    | "end"
    | "field"
    | "title";
  id: string;
  hidden?: boolean;
  line: string;
  position?: "after" | "before" | "inline";
};

export type MermaidPacketModel = {
  sourceDocument: PacketSourceDocument;
  metadataKeys?: Partial<
    Record<
      "title" | "accessibility-title" | "accessibility-description",
      string
    >
  >;
  configResolution: ReturnType<typeof readPacketConfig>;
  diagnostics: MermaidPacketDiagnostic[];
  accessibilityDescription: string;
  accessibilityTitle: string;
  comments?: MermaidPacketComment[];
  diagramType: "packet";
  directives: string[];
  fields: MermaidPacketField[];
  headerLine: string;
  hasAccessibilityDescription?: boolean;
  hasAccessibilityTitle?: boolean;
  hasTitle?: boolean;
  issues: MermaidPacketLayoutIssue[];
  passthroughLines: string[];
  preambleComments?: string[];
  sourceHash: string;
  totalWidth: number;
  title: string;
  version: 1;
};

export type MermaidPacketLayoutIssue = {
  code: "gap" | "invalid-range" | "overlap";
  endBit: number;
  fieldIds: string[];
  startBit: number;
  line?: number;
  expectedStart?: number;
};
