// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../contracts.js";

/** Contributions belong to the local Mermaid block action row. */
export const mermaidTimelineEmbeddedActions: readonly MermaidFamilyToolbarAction[] =
  [
    {
      commandId: "timeline.section.add",
      id: "timeline.add-section",
      label: mermaidMessages.ganttAddSection(),
    },
    {
      commandId: "timeline.period.add",
      id: "timeline.add-period",
      label: mermaidMessages.timelineAddPeriod(),
    },
    {
      commandId: "timeline.event.add",
      id: "timeline.add-event",
      label: mermaidMessages.timelineAddEvent(),
    },
    {
      commandId: "timeline.comments.open",
      id: "timeline.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "timeline.appearance.open",
      id: "timeline.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "timeline.more.open",
      id: "timeline.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
