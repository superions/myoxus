// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidJourneyModel,
  JourneyCommand,
  JourneyCommandResult,
} from "../../engine/journey/index.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../runtime/shell-contract.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";

export type MermaidJourneySelection =
  { stepId?: string; sectionId?: string } | undefined;
/** Local drafts never persist. This is the single bridge to the global source/history owner. */
export type MermaidJourneyReactHostProps = {
  readonly model: MermaidJourneyModel;
  readonly readonly: boolean;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly selection: MermaidJourneySelection;
  readonly replayed: boolean;
  readonly onExportMmd?: () => void;
  readonly onSelectionChange: (selection: MermaidJourneySelection) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onCommand: (
    command: JourneyCommand | readonly JourneyCommand[],
    baseSource?: string,
  ) => JourneyCommandResult;
  readonly onPreviewCommand: (
    command: JourneyCommand | readonly JourneyCommand[],
    baseSource?: string,
  ) => JourneyCommandResult;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};
export const mermaidJourneyRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidJourneyReactHostProps>(
    "journey",
  );
