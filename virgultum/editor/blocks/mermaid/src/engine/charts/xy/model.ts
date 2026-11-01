// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyDiagnostic } from "./diagnostics.js";
import type {
  MermaidXyHeaderForm,
  MermaidXyOrientation,
  MermaidXySourceDocument,
  MermaidXyTextForm,
  MermaidXyXAxisSourceForm,
} from "./source-document.js";

export type MermaidXyPlotKind = "bar" | "line";

export type MermaidXyCategory = {
  id: string;
  label: string;
  order: number;
  sourceFingerprint: string;
  sourceRangeStart: number;
  textForm: MermaidXyTextForm;
};

export type MermaidXyPoint = {
  id: string;
  label: string;
  labelForm?: MermaidXyTextForm;
  order: number;
  plotId: string;
  sourceFingerprint: string;
  sourceRangeStart: number;
  value: number;
};

export type MermaidXyPlot = {
  id: string;
  kind: MermaidXyPlotKind;
  order: number;
  points: MermaidXyPoint[];
  sourceFingerprint: string;
  sourceRecordId: string;
  title: string;
  titleExplicit: boolean;
  titleForm?: MermaidXyTextForm;
};

export type MermaidXyChildIdentity = {
  id: string;
  sourceFingerprint: string;
  sourceRangeStart: number;
};

export type MermaidXyPlotIdentity = MermaidXyChildIdentity & {
  points: MermaidXyChildIdentity[];
  sourceRecordId: string;
};

export type MermaidXyIdentityArchive = {
  categories: MermaidXyChildIdentity[];
  plots: MermaidXyPlotIdentity[];
};

export type MermaidXyAxisConfig = {
  axisLineWidth?: number;
  labelFontSize?: number;
  labelPadding?: number;
  labelRotation?: number;
  showAxisLine?: boolean;
  showLabel?: boolean;
  showTick?: boolean;
  showTitle?: boolean;
  tickLength?: number;
  tickWidth?: number;
  titleFontSize?: number;
  titlePadding?: number;
};

export type MermaidXyConfig = {
  chartOrientation?: MermaidXyOrientation;
  height?: number;
  plotReservedSpacePercent?: number;
  showDataLabel?: boolean;
  showDataLabelOutsideBar?: boolean;
  showTitle?: boolean;
  titleFontSize?: number;
  titlePadding?: number;
  useMaxWidth?: boolean;
  width?: number;
  xAxis?: MermaidXyAxisConfig;
  yAxis?: MermaidXyAxisConfig;
};

export type MermaidXyCommentAnchor =
  | { kind: "diagram" }
  | { id: string; kind: "metadata" | "plot" | "x-axis" | "y-axis" };

export type MermaidXyComment = {
  anchor: MermaidXyCommentAnchor;
  id: string;
  position: "after" | "before";
  sourceRecordId: string;
  text: string;
};

export type MermaidXyXAxis = {
  categories: MermaidXyCategory[];
  effectiveKind: "band" | "linear";
  effectiveMaximum: number;
  effectiveMinimum: number;
  id: "xy-axis-x";
  sourceForm: MermaidXyXAxisSourceForm;
  sourceRecordId?: string;
  title: string;
  titleForm?: MermaidXyTextForm;
};

export type MermaidXyYAxis = {
  id: "xy-axis-y";
  maximum: number;
  minimum: number;
  rangeExplicit: boolean;
  sourceRecordId?: string;
  title: string;
  titleForm?: MermaidXyTextForm;
};

export type MermaidXyModel = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  comments: MermaidXyComment[];
  config: MermaidXyConfig;
  diagnostics: MermaidXyDiagnostic[];
  diagramType: "xychart";
  directives: string[];
  headerForm: MermaidXyHeaderForm;
  headerLine: string;
  headerOrientation?: MermaidXyOrientation;
  identityArchive?: MermaidXyIdentityArchive;
  orientation: MermaidXyOrientation;
  plots: MermaidXyPlot[];
  sourceDocument: MermaidXySourceDocument;
  sourceHash: string;
  title: string;
  titleForm?: MermaidXyTextForm;
  version: 2;
  xAxis: MermaidXyXAxis;
  yAxis: MermaidXyYAxis;
};

/** Mermaid 11.16.1 XY config defaults projected by the visual owner. */
export const DEFAULT_MERMAID_XY_CONFIG: Readonly<Required<MermaidXyConfig>> = {
  chartOrientation: "vertical",
  height: 500,
  plotReservedSpacePercent: 50,
  showDataLabel: false,
  showDataLabelOutsideBar: false,
  showTitle: true,
  titleFontSize: 20,
  titlePadding: 10,
  useMaxWidth: true,
  width: 700,
  xAxis: {
    axisLineWidth: 2,
    labelFontSize: 14,
    labelPadding: 5,
    labelRotation: 0,
    showAxisLine: true,
    showLabel: true,
    showTick: true,
    showTitle: true,
    tickLength: 5,
    tickWidth: 2,
    titleFontSize: 16,
    titlePadding: 5,
  },
  yAxis: {
    axisLineWidth: 2,
    labelFontSize: 14,
    labelPadding: 5,
    labelRotation: 0,
    showAxisLine: true,
    showLabel: true,
    showTick: true,
    showTitle: true,
    tickLength: 5,
    tickWidth: 2,
    titleFontSize: 16,
    titlePadding: 5,
  },
};

const MAX_RETIRED_XY_IDENTITIES = 100;

function childIdentity(
  value: MermaidXyCategory | MermaidXyPoint,
): MermaidXyChildIdentity {
  return {
    id: value.id,
    sourceFingerprint: value.sourceFingerprint,
    sourceRangeStart: value.sourceRangeStart,
  };
}

function mergeChildIdentity(
  archive: MermaidXyChildIdentity[],
  identity: MermaidXyChildIdentity,
) {
  return [
    ...archive.filter(
      (candidate) =>
        candidate.id !== identity.id &&
        !(
          candidate.sourceFingerprint === identity.sourceFingerprint &&
          candidate.sourceRangeStart === identity.sourceRangeStart
        ),
    ),
    identity,
  ];
}

/**
 * Keeps runtime-only identities across history/collaboration reparses. Mermaid
 * source remains authoritative and receives no synthetic identity syntax.
 */
export function refreshMermaidXyIdentityArchive(model: MermaidXyModel) {
  let categories = [...(model.identityArchive?.categories ?? [])];
  for (const category of model.xAxis.categories)
    categories = mergeChildIdentity(categories, childIdentity(category));

  let plots = [...(model.identityArchive?.plots ?? [])];
  for (const plot of model.plots) {
    const archived = plots.find(
      (candidate) => candidate.sourceRecordId === plot.sourceRecordId,
    );
    let points = [...(archived?.points ?? [])];
    for (const point of plot.points)
      points = mergeChildIdentity(points, childIdentity(point));
    const currentPointIds = new Set(plot.points.map((point) => point.id));
    points = [
      ...points.filter((point) => currentPointIds.has(point.id)),
      ...points
        .filter((point) => !currentPointIds.has(point.id))
        .slice(-MAX_RETIRED_XY_IDENTITIES),
    ];
    plots = [
      ...plots.filter(
        (candidate) => candidate.sourceRecordId !== plot.sourceRecordId,
      ),
      {
        id: plot.id,
        points,
        sourceFingerprint: plot.sourceFingerprint,
        sourceRangeStart:
          model.sourceDocument.records.find(
            (record) => record.id === plot.sourceRecordId,
          )?.range.start ?? 0,
        sourceRecordId: plot.sourceRecordId,
      },
    ];
  }
  const currentCategoryIds = new Set(
    model.xAxis.categories.map((category) => category.id),
  );
  categories = [
    ...categories.filter((category) => currentCategoryIds.has(category.id)),
    ...categories
      .filter((category) => !currentCategoryIds.has(category.id))
      .slice(-MAX_RETIRED_XY_IDENTITIES),
  ];
  const currentPlotRecordIds = new Set(
    model.plots.map((plot) => plot.sourceRecordId),
  );
  plots = [
    ...plots.filter((plot) => currentPlotRecordIds.has(plot.sourceRecordId)),
    ...plots
      .filter((plot) => !currentPlotRecordIds.has(plot.sourceRecordId))
      .slice(-MAX_RETIRED_XY_IDENTITIES),
  ];
  model.identityArchive = { categories, plots };
}
