// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidPieDiagnostic } from "./diagnostics.js";
import type { MermaidPieSourceDocument } from "./source-document.js";

export type MermaidPieLegendPosition =
  "bottom" | "center" | "left" | "right" | "top";

export type MermaidPieOptions = {
  donutHole: number;
  highlightSlice: string;
  legendPosition: MermaidPieLegendPosition;
  textPosition: number;
};

export type MermaidPieSlice = {
  id: string;
  label: string;
  order: number;
  sourceFingerprint?: string;
  sourceRecordId?: string;
  value: number;
};

export type MermaidPieComment = {
  anchorId?: string;
  anchorKind: "diagram" | "metadata" | "option" | "slice";
  id: string;
  position: "after" | "before";
  text: string;
};

export type MermaidPieRuntimeConflict = {
  diagnosticId: string;
  firstSliceId: string;
  id: string;
  label: string;
  sliceId: string;
  sourceFingerprint: string;
  sourceRecordId: string;
  value: number;
};

export type MermaidPieModel = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  comments: MermaidPieComment[];
  conflicts: MermaidPieRuntimeConflict[];
  diagramType: "pie";
  diagnostics: MermaidPieDiagnostic[];
  directives: string[];
  headerLine: string;
  options: MermaidPieOptions;
  showData: boolean;
  slices: MermaidPieSlice[];
  sourceDocument: MermaidPieSourceDocument;
  sourceHash: string;
  title: string;
  version: 1;
};

export const DEFAULT_MERMAID_PIE_OPTIONS: Readonly<MermaidPieOptions> = {
  donutHole: 0,
  highlightSlice: "",
  legendPosition: "right",
  textPosition: 0.75,
};
