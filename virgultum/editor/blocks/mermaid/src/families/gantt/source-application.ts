// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyGanttCommands,
  type GanttCommand,
} from "../../engine/gantt/commands/index.js";
import type { MermaidGanttModel } from "../../engine/gantt/types.js";
import {
  ganttNoChange,
  type GanttCommandResult,
} from "../../engine/gantt/writer.js";

/** Stages a multi-field draft fully before the host creates one history item. */
export function applyMermaidGanttFamilySourceCommand(input: {
  readonly model: MermaidGanttModel;
  readonly source: string;
  readonly readonly: boolean;
  readonly command: GanttCommand | readonly GanttCommand[];
}): GanttCommandResult {
  const commands: readonly GanttCommand[] = Array.isArray(input.command)
    ? input.command
    : [input.command as GanttCommand];
  return (
    applyGanttCommands({
      commands,
      model: input.model,
      readonly: input.readonly,
    }) ?? ganttNoChange(input.model, "no-change")
  );
}
