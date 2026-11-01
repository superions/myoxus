// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidXyCommand,
  MermaidXyCommandSelection,
} from "../../../engine/charts/xy/commands/types.js";
import type { MermaidXyModel } from "../../../engine/charts/xy/model.js";
import type { MermaidPageViewportProjection } from "../../../mermaid-page-viewport-state.js";
import type { MermaidRuntimeTransactionOptions } from "../../runtime/transaction.js";
import {
  defineMermaidFamilyReactRendererToken,
  type MermaidFamilyReactRendererToken,
} from "../../runtime/react-host.js";
import type { MermaidSelectionActionModel } from "../../runtime/shell-contract.js";

export type MermaidXyReactHostProps = {
  actionTarget?: HTMLElement | null;
  embedded: boolean;
  headerActionTarget?: HTMLElement | null;
  labels: {
    accessibilityDescription: string;
    accessibilityTitle: string;
    addCategory: string;
    addComment: string;
    addPlot: string;
    addPoint: string;
    apply: string;
    autoAxis: string;
    axes: string;
    appearance: string;
    bar: string;
    bandAxis: string;
    cancel: string;
    category: string;
    chart: string;
    comments: string;
    data: string;
    delete: string;
    deleteCategoryImpact: (category: string, count: number) => string;
    deleteCategoryPlotValue: (plot: string, value: string) => string;
    deleteCategoryPlotMissing: (plot: string) => string;
    deletePlotImpact: (plot: string, type: string, count: number) => string;
    deletePointImpact: (
      plot: string,
      position: number,
      count: number,
    ) => string;
    deleteLinearPointImpact: (
      plot: string,
      position: number,
      count: number,
    ) => string;
    down: string;
    empty: string;
    explicitRange: string;
    horizontal: string;
    invalid: string;
    label: string;
    line: string;
    linearAxis: string;
    linearPointOrderImpact: (plot: string) => string;
    more: string;
    markdown: string;
    plain: string;
    plot: string;
    reset: string;
    retry: string;
    rendererError: string;
    quoted: string;
    sourceChanged: string;
    source: string;
    up: string;
    value: string;
    valueStep: (step: number, largeStep: number) => string;
    vertical: string;
    x: string;
    xAxisEnd: string;
    xAxisStart: string;
    y: string;
    yAxisMaximum: string;
    yAxisMinimum: string;
    axisConversionImpact: string;
    autoXSource: (plot: string, maximum: number) => string;
    plotPointCount: (plot: string, count: number) => string;
    rangePreview: (minimum: number, maximum: number) => string;
    orientationAuthority: (header: string, config: string) => string;
    plotPositions: (plot: string, positions: string) => string;
    unmatchedPoint: (position: number) => string;
    missingPoint: string;
    commandFailure: (code: string) => string;
    appearanceFields: {
      axisLineWidth: string;
      height: string;
      labelFontSize: string;
      labelPadding: string;
      labelRotation: string;
      plotReservedSpacePercent: string;
      showAxisLine: string;
      showDataLabel: string;
      showDataLabelOutsideBar: string;
      showLabel: string;
      showTick: string;
      showTitle: string;
      tickLength: string;
      tickWidth: string;
      titleFontSize: string;
      titlePadding: string;
      useMaxWidth: string;
      width: string;
    };
  };
  model: MermaidXyModel;
  initialDataOpen: boolean;
  onCommand: (
    command: MermaidXyCommand | readonly MermaidXyCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => {
    changed: boolean;
    diagnosis: string;
    model: MermaidXyModel;
    selection: MermaidXyCommandSelection | null;
  };
  onPreviewCommand: (
    command: MermaidXyCommand | readonly MermaidXyCommand[],
  ) => {
    changed: boolean;
    diagnosis: string;
    model: MermaidXyModel;
    selection: MermaidXyCommandSelection | null;
  };
  getRememberedSelection: (model: MermaidXyModel) => string | undefined;
  rememberSelection: (model: MermaidXyModel, selection?: string) => void;
  onOpenSource: () => void;
  onDataOpenChange: (opened: boolean) => void;
  onSelectionActionChange: (action: MermaidSelectionActionModel | null) => void;
  onTitlePresentationPreview: (
    presentation: {
      readonly fontSize?: number;
      readonly padding?: number;
      readonly visible: boolean;
    } | null,
  ) => void;
  pageViewport: MermaidPageViewportProjection;
  readonly: boolean;
};

export const mermaidXyRendererToken: MermaidFamilyReactRendererToken<MermaidXyReactHostProps> =
  defineMermaidFamilyReactRendererToken("xy");
