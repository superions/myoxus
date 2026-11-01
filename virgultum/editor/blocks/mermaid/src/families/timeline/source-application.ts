// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyTimelineCommands,
  type TimelineCommand,
  type MermaidTimelineModel,
} from "../../engine/timeline/index.js";

/** Source and capability are checked again at Apply, independent of an open React draft. */
export function applyMermaidTimelineFamilySourceCommand(input: {
  readonly model: MermaidTimelineModel;
  readonly source: string;
  readonly readonly: boolean;
  readonly command: TimelineCommand | readonly TimelineCommand[];
}) {
  return applyTimelineCommands(
    input.model,
    Array.isArray(input.command)
      ? input.command
      : [input.command as TimelineCommand],
    { baseSource: input.source, readonly: input.readonly },
  );
}
