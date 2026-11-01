// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyKanbanCommands,
  type KanbanCommand,
  type MermaidKanbanModel,
} from "../../engine/kanban/index.js";
export function applyMermaidKanbanFamilySourceCommand(
  model: MermaidKanbanModel,
  command: KanbanCommand | readonly KanbanCommand[],
  baseSource: string,
  readonly: boolean,
) {
  return applyKanbanCommands(
    model,
    Array.isArray(command) ? command : [command as KanbanCommand],
    { baseSource, readonly },
  );
}
