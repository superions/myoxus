// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyCommand } from "../../../engine/charts/sankey/commands/index.js";
import type { SankeyModel } from "../../../engine/charts/sankey/model.js";
import type {
  SankeyCommandResult,
  SankeySelection,
} from "../../../engine/charts/sankey/writer.js";
import type { MermaidPageViewportProjection } from "../../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../../runtime/shell-contract.js";
import type { MermaidRuntimeTransactionOptions } from "../../runtime/transaction.js";
import { defineMermaidFamilyReactRendererToken } from "../../runtime/react-host.js";

export type MermaidSankeyReactHostProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly readonly: boolean;
  readonly model: SankeyModel;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly initialDataOpen: boolean;
  readonly selection: SankeySelection;
  readonly onCommand: (
    command: SankeyCommand | readonly SankeyCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => SankeyCommandResult;
  readonly onPreviewCommand: (
    command: SankeyCommand | readonly SankeyCommand[],
  ) => SankeyCommandResult;
  readonly onSelectionChange: (selection: SankeySelection) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onDataOpenChange: (opened: boolean) => void;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};

export const mermaidSankeyRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidSankeyReactHostProps>("sankey");
