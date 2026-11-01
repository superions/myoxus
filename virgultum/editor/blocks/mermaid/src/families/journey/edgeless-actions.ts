// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../contracts.js";
export const mermaidJourneyEmbeddedActions: readonly MermaidFamilyToolbarAction[] =
  [
    {
      commandId: "journey.section.add",
      id: "journey.add-section",
      label: messages.journeyAddSection(),
    },
    {
      commandId: "journey.step.add",
      id: "journey.add-step",
      label: messages.journeyAddStep(),
    },
    {
      commandId: "journey.comments",
      id: "journey.comments",
      label: messages.visualComments(),
    },
    {
      commandId: "journey.appearance",
      id: "journey.appearance",
      label: messages.visualAppearance(),
    },
    {
      commandId: "journey.actors",
      id: "journey.actors",
      label: messages.journeyActors(),
    },
    {
      commandId: "journey.accessibility",
      id: "journey.accessibility",
      label: messages.visualAccessibility(),
    },
    {
      commandId: "journey.data",
      id: "journey.data",
      label: messages.treemapData(),
    },
    {
      commandId: "journey.more",
      id: "journey.more",
      label: messages.visualMoreActions(),
    },
  ];
