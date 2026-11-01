// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyToolbarAction } from "../contracts.js";

/** Gantt domain actions render inside the embedded owner, never beside it. */
export const mermaidGanttEmbeddedActions: readonly MermaidFamilyToolbarAction[] =
  [
    {
      commandId: "gantt.task.add",
      id: "gantt.add-task",
      label: mermaidMessages.ganttAddTask(),
    },
    {
      commandId: "gantt.task.add-milestone",
      id: "gantt.add-milestone",
      label: mermaidMessages.ganttAddMilestone(),
    },
    {
      commandId: "gantt.section.add",
      id: "gantt.add-section",
      label: mermaidMessages.ganttAddSection(),
    },
    {
      commandId: "gantt.dependency.create",
      id: "gantt.dependency",
      label: mermaidMessages.ganttDependency(),
    },
    {
      commandId: "gantt.comments.open",
      id: "gantt.comments",
      label: mermaidMessages.visualComments(),
    },
    {
      commandId: "gantt.appearance.open",
      id: "gantt.appearance",
      label: mermaidMessages.visualAppearance(),
    },
    {
      commandId: "gantt.more.open",
      id: "gantt.more",
      label: mermaidMessages.visualMoreActions(),
    },
  ];
