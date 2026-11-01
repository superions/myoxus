// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../contracts.js";
export const mermaidKanbanEmbeddedActions: readonly MermaidFamilyToolbarAction[] =
  [
    {
      commandId: "kanban.column.add",
      id: "kanban.add-column",
      label: messages.kanbanAddColumn(),
    },
    {
      commandId: "kanban.comments",
      id: "kanban.comments",
      label: messages.visualComments(),
    },
    {
      commandId: "kanban.appearance",
      id: "kanban.appearance",
      label: messages.visualAppearance(),
    },
    {
      commandId: "kanban.tickets",
      id: "kanban.tickets",
      label: messages.kanbanTickets(),
    },
    {
      commandId: "kanban.data",
      id: "kanban.data",
      label: messages.treemapData(),
    },
    {
      commandId: "kanban.more",
      id: "kanban.more",
      label: messages.visualMoreActions(),
    },
  ];
