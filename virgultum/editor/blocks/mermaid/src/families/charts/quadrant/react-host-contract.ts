// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidQuadrantCommand,
  MermaidQuadrantCommandSelection,
} from "../../../engine/charts/quadrant/commands/types.js";
import type {
  MermaidQuadrantComment,
  MermaidQuadrantModel,
} from "../../../engine/charts/quadrant/model.js";
import type { MermaidPageViewportProjection } from "../../../mermaid-page-viewport-state.js";
import type { MermaidRuntimeTransactionOptions } from "../../runtime/transaction.js";
import {
  defineMermaidFamilyReactRendererToken,
  type MermaidFamilyReactRendererToken,
} from "../../runtime/react-host.js";
import type { MermaidSelectionActionModel } from "../../runtime/shell-contract.js";

export type MermaidQuadrantReactHostProps = {
  actionTarget?: HTMLElement | null;
  comments: readonly MermaidQuadrantComment[];
  embedded: boolean;
  labels: {
    accessibilityDescription: string;
    accessibilityTitle: string;
    add: string;
    addComment: string;
    apply: string;
    appearance: string;
    bottom: string;
    cancel: string;
    chart: string;
    classes: string;
    classDefinitions: string;
    comments: string;
    coordinates: string;
    data: string;
    delete: string;
    deleteComment: string;
    down: string;
    empty: string;
    exportMmd: string;
    invalid: string;
    label: string;
    labelForm: string;
    left: string;
    markdown: string;
    more: string;
    plain: string;
    pointRadius: string;
    position: string;
    quoted: string;
    quadrantLabel: string;
    reset: string;
    right: string;
    fillColor: string;
    fontSize: string;
    height: string;
    internalBorder: string;
    externalBorder: string;
    useMaxWidth: string;
    width: string;
    padding: string;
    strokeColor: string;
    strokeWidth: string;
    style: string;
    top: string;
    sourceChanged: string;
    up: string;
    x: string;
    xAxisEnd: string;
    xAxisStart: string;
    y: string;
    yAxisEnd: string;
    yAxisStart: string;
  };
  model: MermaidQuadrantModel;
  onCommand: (
    command: MermaidQuadrantCommand | readonly MermaidQuadrantCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => MermaidQuadrantCommandSelection | null;
  onExportMmd: () => void;
  onSelectionActionChange: (action: MermaidSelectionActionModel | null) => void;
  pageViewport: MermaidPageViewportProjection;
  readonly: boolean;
};

export const mermaidQuadrantRendererToken: MermaidFamilyReactRendererToken<MermaidQuadrantReactHostProps> =
  defineMermaidFamilyReactRendererToken("quadrant");
