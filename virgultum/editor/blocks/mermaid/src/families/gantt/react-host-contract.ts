// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GanttCommand } from "../../engine/gantt/commands/index.js";
import type {
  GanttSelection,
  MermaidGanttModel,
} from "../../engine/gantt/types.js";
import type { GanttCommandResult } from "../../engine/gantt/writer.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../runtime/shell-contract.js";
import type { MermaidRuntimeTransactionOptions } from "../runtime/transaction.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";

/**
 * The Gantt host contract is command based: React owns selection, focus and
 * draft/popover state only, while every mutation travels through the typed
 * engine commands and the global Mermaid history transaction.
 */
export type MermaidGanttReactHostProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly readonly: boolean;
  readonly model: MermaidGanttModel;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly initialDataOpen: boolean;
  readonly selection: GanttSelection;
  readonly onCommand: (
    command: GanttCommand | readonly GanttCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => GanttCommandResult;
  readonly onPreviewCommand: (
    command: GanttCommand | readonly GanttCommand[],
  ) => GanttCommandResult;
  readonly onSelectionChange: (selection: GanttSelection) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onDataOpenChange: (opened: boolean) => void;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};

export const mermaidGanttRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidGanttReactHostProps>("gantt");
