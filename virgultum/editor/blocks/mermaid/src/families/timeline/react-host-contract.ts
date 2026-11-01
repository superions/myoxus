// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  TimelineCommand,
  TimelineCommandResult,
  TimelineSelection,
  MermaidTimelineModel,
} from "../../engine/timeline/index.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../runtime/shell-contract.js";
import type { MermaidRuntimeTransactionOptions } from "../runtime/transaction.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";

/** React owns local interaction; source commands and global Mermaid history own persistence. */
export type MermaidTimelineReactHostProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly readonly: boolean;
  readonly model: MermaidTimelineModel;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly initialCommentsOpen: boolean;
  readonly selection: TimelineSelection;
  readonly onCommand: (
    command: TimelineCommand | readonly TimelineCommand[],
    baseSource?: string,
    options?: MermaidRuntimeTransactionOptions,
  ) => TimelineCommandResult;
  readonly onPreviewCommand: (
    command: TimelineCommand | readonly TimelineCommand[],
    baseSource?: string,
  ) => TimelineCommandResult;
  readonly onSelectionChange: (selection: TimelineSelection) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onCommentsOpenChange: (opened: boolean) => void;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};

export const mermaidTimelineRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidTimelineReactHostProps>(
    "timeline",
  );
