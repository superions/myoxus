// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidRadarDiagnostic } from "./diagnostics.js";
import type {
  MermaidRadarOptionName,
  MermaidRadarQuoteForm,
  MermaidRadarSourceDocument,
  MermaidRadarValueForm,
} from "./source-document.js";

export type MermaidRadarAxis = {
  readonly id: string;
  readonly label: string;
  readonly labelExplicit: boolean;
  readonly labelQuote?: MermaidRadarQuoteForm;
  readonly name: string;
  readonly order: number;
  readonly sourceFingerprint: string;
  readonly sourceRangeStart: number;
  readonly sourceRecordId: string;
};

export type MermaidRadarEntry = {
  readonly axisId?: string;
  readonly axisName?: string;
  readonly colon: boolean;
  readonly id: string;
  readonly order: number;
  readonly precision: number;
  readonly sourceFingerprint: string;
  readonly sourceRangeStart: number;
  readonly status: "duplicate" | "extra" | "resolved" | "unknown";
  readonly value: number;
};

export type MermaidRadarVertex = {
  readonly axisId: string;
  readonly curveId: string;
  readonly entryId?: string;
  readonly id: string;
  readonly order: number;
  readonly state:
    "clipped-high" | "clipped-low" | "duplicate" | "missing" | "present";
  readonly value?: number;
};

export type MermaidRadarCurve = {
  readonly entries: MermaidRadarEntry[];
  readonly id: string;
  readonly label: string;
  readonly labelExplicit: boolean;
  readonly labelQuote?: MermaidRadarQuoteForm;
  readonly name: string;
  readonly order: number;
  readonly sourceFingerprint: string;
  readonly sourceForm: MermaidRadarValueForm;
  readonly sourceRangeStart: number;
  readonly sourceRecordId: string;
  readonly vertices: MermaidRadarVertex[];
};

export type MermaidRadarOptions = {
  readonly effective: {
    readonly graticule: "circle" | "polygon";
    readonly maximum: number | null;
    readonly minimum: number;
    readonly showLegend: boolean;
    readonly ticks: number;
  };
  readonly explicit: Partial<{
    graticule: "circle" | "polygon";
    max: number;
    min: number;
    showLegend: boolean;
    ticks: number;
  }>;
  readonly sourceRecordIds: Partial<Record<MermaidRadarOptionName, string>>;
};

export type MermaidRadarConfig = Partial<{
  axisLabelFactor: number;
  axisScaleFactor: number;
  curveTension: number;
  height: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  useMaxWidth: boolean;
  width: number;
}>;

export const DEFAULT_MERMAID_RADAR_CONFIG = {
  axisLabelFactor: 1.05,
  axisScaleFactor: 1,
  curveTension: 0.17,
  height: 600,
  marginBottom: 50,
  marginLeft: 50,
  marginRight: 50,
  marginTop: 50,
  useMaxWidth: true,
  width: 600,
} as const satisfies Required<MermaidRadarConfig>;

export function mermaidRadarConfigDiagnosis(
  config: Required<MermaidRadarConfig>,
) {
  const numericFields = [
    "width",
    "height",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "axisScaleFactor",
    "axisLabelFactor",
    "curveTension",
  ] as const;
  const nonFinite = numericFields.find(
    (field) => !Number.isFinite(config[field]),
  );
  if (nonFinite) return `radar.config.${nonFinite}`;
  if (config.width <= 0) return "radar.config.width";
  if (config.height <= 0) return "radar.config.height";
  if (config.axisScaleFactor <= 0) return "radar.config.axisScaleFactor";
  if (config.axisLabelFactor <= 0) return "radar.config.axisLabelFactor";
  if (config.curveTension < 0) return "radar.config.curveTension";
  const marginFields = [
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
  ] as const;
  const negativeMargin = marginFields.find((field) => config[field] < 0);
  if (negativeMargin) return `radar.config.${negativeMargin}`;
  if (config.marginLeft + config.marginRight >= config.width)
    return "radar.config.horizontalGeometry";
  if (config.marginTop + config.marginBottom >= config.height)
    return "radar.config.verticalGeometry";
  return null;
}

export const DEFAULT_MERMAID_RADAR_OPTIONS = {
  graticule: "circle",
  max: null,
  min: 0,
  showLegend: true,
  ticks: 5,
} as const;

export type MermaidRadarCommentAnchor =
  | { readonly kind: "diagram" }
  | {
      readonly id: string;
      readonly kind: "axis" | "curve" | "metadata" | "options";
    };

export type MermaidRadarComment = {
  readonly anchor: MermaidRadarCommentAnchor;
  readonly id: string;
  readonly position: "after" | "before";
  readonly sourceRecordId: string;
  readonly text: string;
};

export type MermaidRadarIdentityArchive = {
  readonly axes: ReadonlyArray<
    Pick<
      MermaidRadarAxis,
      "id" | "name" | "sourceFingerprint" | "sourceRangeStart"
    >
  >;
  readonly curves: ReadonlyArray<
    Pick<
      MermaidRadarCurve,
      "id" | "name" | "sourceFingerprint" | "sourceRangeStart"
    > & {
      readonly entries: ReadonlyArray<
        Pick<
          MermaidRadarEntry,
          | "axisId"
          | "axisName"
          | "id"
          | "sourceFingerprint"
          | "sourceRangeStart"
        >
      >;
    }
  >;
};

export type MermaidRadarModel = {
  readonly accessibilityDescription: string;
  readonly accessibilityTitle: string;
  readonly axes: MermaidRadarAxis[];
  readonly comments: MermaidRadarComment[];
  readonly config: MermaidRadarConfig;
  readonly curves: MermaidRadarCurve[];
  readonly diagnostics: MermaidRadarDiagnostic[];
  readonly diagramType: "radar";
  readonly headerLine: string;
  readonly identityArchive: MermaidRadarIdentityArchive;
  readonly options: MermaidRadarOptions;
  readonly sourceDocument: MermaidRadarSourceDocument;
  readonly sourceHash: string;
  readonly title: string;
  readonly version: 2;
};
