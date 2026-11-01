// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommand,
  MermaidRadarCommandSelection,
} from "../../../engine/charts/radar/commands/types.js";
import type { MermaidRadarModel } from "../../../engine/charts/radar/model.js";
import type { MermaidPageViewportProjection } from "../../../mermaid-page-viewport-state.js";
import type { MermaidRuntimeTransactionOptions } from "../../runtime/transaction.js";
import {
  defineMermaidFamilyReactRendererToken,
  type MermaidFamilyReactRendererToken,
} from "../../runtime/react-host.js";
import type { MermaidSelectionActionModel } from "../../runtime/shell-contract.js";

export type MermaidRadarCommandProjection = {
  readonly changed: boolean;
  readonly diagnosis: string;
  readonly model: MermaidRadarModel;
  readonly selection: MermaidRadarCommandSelection | null;
};

export type MermaidRadarReactHostProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly headerActionTarget?: HTMLElement | null;
  readonly initialDataOpen: boolean;
  readonly labels: {
    readonly accessibilityDescription: string;
    readonly accessibilityTitle: string;
    readonly addAxis: string;
    readonly addComment: string;
    readonly addCurve: string;
    readonly ambiguousSource: string;
    readonly apply: string;
    readonly automatic: string;
    readonly axis: string;
    readonly cancel: string;
    readonly circle: string;
    readonly comments: string;
    readonly configuration: string;
    readonly configurationFields: {
      readonly axisLabelFactor: string;
      readonly axisScaleFactor: string;
      readonly curveTension: string;
      readonly height: string;
      readonly marginBottom: string;
      readonly marginLeft: string;
      readonly marginRight: string;
      readonly marginTop: string;
      readonly useMaxWidth: string;
      readonly width: string;
    };
    readonly curve: string;
    readonly clippedVertices: (count: number) => string;
    readonly commentCount: (count: number) => string;
    readonly commentAfter: string;
    readonly commentAnchor: (
      anchor: string,
      position: string,
      line: number,
    ) => string;
    readonly commentBefore: string;
    readonly commentOwnerRemovalBlocked: string;
    readonly conversionImpact: (axis: string, value: string) => string;
    readonly convertForm: string;
    readonly data: string;
    readonly delete: string;
    readonly deleteAxisImpact: (
      name: string,
      label: string,
      curves: number,
    ) => string;
    readonly deleteCurveImpact: (
      name: string,
      label: string,
      vertices: number,
      comments: number,
    ) => string;
    readonly deleteVertexImpact: string;
    readonly defaultValue: (value: string) => string;
    readonly detailed: string;
    readonly duplicateReference: string;
    readonly emptyAxes: string;
    readonly emptyCurves: string;
    readonly effectiveValue: (value: string) => string;
    readonly graticule: string;
    readonly invalid: string;
    readonly invalidConfig: string;
    readonly invalidNumber: string;
    readonly invalidOption: string;
    readonly invalidRange: string;
    readonly label: string;
    readonly maximum: string;
    readonly minimum: string;
    readonly missingReference: string;
    readonly more: string;
    readonly name: string;
    readonly options: string;
    readonly polygon: string;
    readonly positional: string;
    readonly reset: string;
    readonly retry: string;
    readonly rendererError: string;
    readonly showLegend: string;
    readonly source: string;
    readonly sourceChanged: string;
    readonly sourceValue: (value: string) => string;
    readonly ticks: string;
    readonly value: string;
    readonly valueStep: (step: string, largeStep: string) => string;
    readonly visualEditor: string;
  };
  readonly model: MermaidRadarModel;
  readonly focusRequest?: {
    readonly key: string;
    readonly selection: MermaidRadarCommandSelection;
  };
  readonly onCommand: (
    command: MermaidRadarCommand | readonly MermaidRadarCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => MermaidRadarCommandProjection;
  readonly onDataOpenChange: (opened: boolean) => void;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onFocusRequestConsumed: () => void;
  readonly onOpenSource: () => void;
  readonly onPreviewCommand: (
    command: MermaidRadarCommand | readonly MermaidRadarCommand[],
  ) => MermaidRadarCommandProjection;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly readonly: boolean;
  readonly getRememberedSelection: (
    model: MermaidRadarModel,
  ) => MermaidRadarCommandSelection | undefined;
  readonly rememberSelection: (
    model: MermaidRadarModel,
    selection?: MermaidRadarCommandSelection,
  ) => void;
};

export const mermaidRadarRendererToken: MermaidFamilyReactRendererToken<MermaidRadarReactHostProps> =
  defineMermaidFamilyReactRendererToken("radar");
