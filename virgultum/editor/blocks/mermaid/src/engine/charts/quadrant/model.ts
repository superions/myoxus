// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidQuadrantDiagnostic } from "./diagnostics.js";
import type {
  MermaidQuadrantAxisForm,
  MermaidQuadrantSourceDocument,
  MermaidQuadrantTextForm,
} from "./source-document.js";

export type MermaidQuadrantInlineStyle = {
  color?: string;
  radius?: number;
  strokeColor?: string;
  strokeWidth?: string;
};

export type MermaidQuadrantPoint = {
  className?: string;
  id: string;
  inlineStyle: MermaidQuadrantInlineStyle;
  label: string;
  labelForm: MermaidQuadrantTextForm;
  order: number;
  runtimePaintOrder: number;
  sourceFingerprint: string;
  sourceRecordId: string;
  x: number;
  y: number;
};

export type MermaidQuadrantAxis = {
  end: string;
  endForm: MermaidQuadrantTextForm;
  form: MermaidQuadrantAxisForm;
  id: string;
  role: "x" | "y";
  sourceRecordId?: string;
  start: string;
  startForm: MermaidQuadrantTextForm;
};

export type MermaidQuadrantText = {
  form: MermaidQuadrantTextForm;
  id: string;
  quadrant: 1 | 2 | 3 | 4;
  sourceRecordId?: string;
  text: string;
};

export type MermaidQuadrantClassDef = {
  id: string;
  name: string;
  sourceRecordId: string;
  style: MermaidQuadrantInlineStyle;
};

export type MermaidQuadrantCommentAnchor =
  | { kind: "diagram" }
  | { id: string; kind: "axis" | "classDef" | "point" | "quadrantText" };

export type MermaidQuadrantComment = {
  anchor: MermaidQuadrantCommentAnchor;
  id: string;
  position: "after" | "before";
  sourceRecordId: string;
  text: string;
};

export type MermaidQuadrantConfig = {
  chartHeight?: number;
  chartWidth?: number;
  pointLabelFontSize?: number;
  pointRadius?: number;
  pointTextPadding?: number;
  quadrantExternalBorderStrokeWidth?: number;
  quadrantInternalBorderStrokeWidth?: number;
  quadrantLabelFontSize?: number;
  quadrantPadding?: number;
  quadrantTextTopPadding?: number;
  titleFontSize?: number;
  titlePadding?: number;
  useMaxWidth?: boolean;
  xAxisLabelFontSize?: number;
  xAxisLabelPadding?: number;
  xAxisPosition?: "bottom" | "top";
  yAxisLabelFontSize?: number;
  yAxisLabelPadding?: number;
  yAxisPosition?: "left" | "right";
};

export type MermaidQuadrantModel = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  axes: { x: MermaidQuadrantAxis; y: MermaidQuadrantAxis };
  classes: MermaidQuadrantClassDef[];
  comments: MermaidQuadrantComment[];
  config: MermaidQuadrantConfig;
  diagnostics: MermaidQuadrantDiagnostic[];
  diagramType: "quadrantChart";
  directives: string[];
  headerLine: string;
  points: MermaidQuadrantPoint[];
  quadrantLabels: [string, string, string, string];
  quadrantTexts: [
    MermaidQuadrantText,
    MermaidQuadrantText,
    MermaidQuadrantText,
    MermaidQuadrantText,
  ];
  sourceDocument: MermaidQuadrantSourceDocument;
  sourceHash: string;
  title: string;
  version: 2;
  xAxisEnd: string;
  xAxisStart: string;
  yAxisEnd: string;
  yAxisStart: string;
};

export const DEFAULT_MERMAID_QUADRANT_CONFIG: Readonly<
  Required<MermaidQuadrantConfig>
> = {
  chartHeight: 500,
  chartWidth: 500,
  pointLabelFontSize: 12,
  pointRadius: 5,
  pointTextPadding: 5,
  quadrantExternalBorderStrokeWidth: 2,
  quadrantInternalBorderStrokeWidth: 1,
  quadrantLabelFontSize: 16,
  quadrantPadding: 5,
  quadrantTextTopPadding: 5,
  titleFontSize: 20,
  titlePadding: 10,
  useMaxWidth: true,
  xAxisLabelFontSize: 16,
  xAxisLabelPadding: 5,
  xAxisPosition: "top",
  yAxisLabelFontSize: 16,
  yAxisLabelPadding: 5,
  yAxisPosition: "left",
};

export function copyMermaidQuadrantModel(
  model: MermaidQuadrantModel,
): MermaidQuadrantModel {
  return {
    ...model,
    axes: {
      x: { ...model.axes.x },
      y: { ...model.axes.y },
    },
    classes: model.classes.map((classDef) => ({
      ...classDef,
      style: { ...classDef.style },
    })),
    comments: model.comments.map((comment) => ({
      ...comment,
      anchor: { ...comment.anchor },
    })),
    config: { ...model.config },
    diagnostics: [...model.diagnostics],
    directives: [...model.directives],
    points: model.points.map((point) => ({
      ...point,
      inlineStyle: { ...point.inlineStyle },
    })),
    quadrantLabels: [...model.quadrantLabels],
    quadrantTexts: model.quadrantTexts.map((text) => ({ ...text })) as [
      MermaidQuadrantText,
      MermaidQuadrantText,
      MermaidQuadrantText,
      MermaidQuadrantText,
    ],
    sourceDocument: {
      ...model.sourceDocument,
      lines: [...model.sourceDocument.lines],
      records: model.sourceDocument.records.map((record) => ({ ...record })),
    },
  };
}
