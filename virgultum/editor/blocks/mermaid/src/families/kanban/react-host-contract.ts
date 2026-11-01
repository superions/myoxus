// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidKanbanModel,
  KanbanCommand,
  KanbanCommandResult,
} from "../../engine/kanban/index.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../runtime/shell-contract.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";

export type MermaidKanbanSelection =
  { cardId?: string; columnId?: string } | undefined;
/** Local drafts never persist. This is the single bridge to the global source/history owner. */
export type MermaidKanbanReactHostProps = {
  readonly model: MermaidKanbanModel;
  readonly readonly: boolean;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly selection: MermaidKanbanSelection;
  readonly replayed: boolean;
  readonly onExportMmd?: () => void;
  readonly onSelectionChange: (selection: MermaidKanbanSelection) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onCommand: (
    command: KanbanCommand | readonly KanbanCommand[],
    baseSource?: string,
  ) => KanbanCommandResult;
  readonly onPreviewCommand: (
    command: KanbanCommand | readonly KanbanCommand[],
    baseSource?: string,
  ) => KanbanCommandResult;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};
export const mermaidKanbanRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidKanbanReactHostProps>("kanban");
