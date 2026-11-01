// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidPieCommand,
  MermaidPieCommandSelection,
} from "../../../engine/charts/pie/commands.js";
import type {
  MermaidPieComment,
  MermaidPieLegendPosition,
  MermaidPieModel,
  MermaidPieOptions,
} from "../../../engine/charts/pie/model.js";
import type { MermaidPageViewportProjection } from "../../../mermaid-page-viewport-state.js";
import type { MermaidRuntimeTransactionOptions } from "../../runtime/transaction.js";
import {
  defineMermaidFamilyReactRendererToken,
  type MermaidFamilyReactRendererToken,
} from "../../runtime/react-host.js";
import type { MermaidSelectionActionModel } from "../../runtime/shell-contract.js";

export type MermaidPieReactHostProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly embedded: boolean;
  readonly labels: {
    readonly add: string;
    readonly addComment: string;
    readonly apply: string;
    readonly appearance: string;
    readonly accessibilityDescription: string;
    readonly accessibilityTitle: string;
    readonly cancel: string;
    readonly chart: string;
    readonly comments: string;
    readonly data: string;
    readonly delete: string;
    readonly deleteComment: string;
    readonly donutHole: string;
    readonly down: string;
    readonly empty: string;
    readonly exportMmd: string;
    readonly inspector: string;
    readonly highlightHover: string;
    readonly highlightNone: string;
    readonly highlightSlice: string;
    readonly invalid: string;
    readonly label: string;
    readonly legendPosition: string;
    readonly legendPositions: Readonly<
      Record<MermaidPieLegendPosition, string>
    >;
    readonly more: string;
    readonly showData: string;
    readonly sourceChanged: string;
    readonly textPosition: string;
    readonly up: string;
    readonly value: string;
    readonly zeroValues: string;
  };
  readonly diagramComments: ReadonlyArray<MermaidPieComment>;
  readonly commentsForSlice: (
    sliceId: string,
  ) => ReadonlyArray<MermaidPieComment>;
  readonly model: MermaidPieModel;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly issue?: string;
    readonly label: string;
    readonly value: number;
  }>;
  readonly newSliceLabel: string;
  readonly onCommand: (
    command: MermaidPieCommand,
    options?: MermaidRuntimeTransactionOptions,
  ) => MermaidPieCommandSelection | null;
  readonly onExportMmd: () => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly readonly: boolean;
  readonly sliceOptions: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
  readonly sliceIdForLabel: (label: string) => string | undefined;
  readonly sliceLabelForId: (sliceId: string) => string | undefined;
  readonly validateSliceDraft: (label: string, value: number) => string | null;
};

export type MermaidPieAppearanceDraft = {
  readonly options: MermaidPieOptions;
  readonly showData: boolean;
};

export const mermaidPieRendererToken: MermaidFamilyReactRendererToken<MermaidPieReactHostProps> =
  defineMermaidFamilyReactRendererToken("pie");
