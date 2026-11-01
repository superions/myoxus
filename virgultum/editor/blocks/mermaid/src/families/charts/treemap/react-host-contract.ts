// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapCommand } from "../../../engine/charts/treemap/commands/index.js";
import type {
  TreemapModel,
  TreemapSelection,
} from "../../../engine/charts/treemap/model.js";
import type { TreemapCommandResult } from "../../../engine/charts/treemap/writer.js";
import type { MermaidPageViewportProjection } from "../../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../../runtime/shell-contract.js";
import type { MermaidRuntimeTransactionOptions } from "../../runtime/transaction.js";
import { defineMermaidFamilyReactRendererToken } from "../../runtime/react-host.js";

export type MermaidTreemapReactHostProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly readonly: boolean;
  readonly model: TreemapModel;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly initialDataOpen: boolean;
  readonly selection: TreemapSelection;
  readonly onCommand: (
    command: TreemapCommand | readonly TreemapCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => TreemapCommandResult;
  readonly onPreviewCommand: (
    command: TreemapCommand | readonly TreemapCommand[],
  ) => TreemapCommandResult;
  readonly onSelectionChange: (selection: TreemapSelection) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onDataOpenChange: (opened: boolean) => void;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};

export const mermaidTreemapRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidTreemapReactHostProps>(
    "treemap",
  );
