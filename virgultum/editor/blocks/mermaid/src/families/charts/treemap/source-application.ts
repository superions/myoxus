// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyTreemapCommand,
  type TreemapCommand,
} from "../../../engine/charts/treemap/commands/index.js";
import type { TreemapModel } from "../../../engine/charts/treemap/model.js";
import {
  treemapNoChange,
  type TreemapCommandResult,
} from "../../../engine/charts/treemap/writer.js";

/** A multi-field draft is staged fully before the host creates one history item. */
export function applyMermaidTreemapFamilySourceCommand(input: {
  readonly model: TreemapModel;
  readonly source: string;
  readonly readonly: boolean;
  readonly command: TreemapCommand | readonly TreemapCommand[];
}): TreemapCommandResult {
  const commands: readonly TreemapCommand[] = Array.isArray(input.command)
    ? input.command
    : [input.command as TreemapCommand];
  let result = {
    ...treemapNoChange(input.model, "no-change"),
    source: input.source,
  };
  for (const command of commands) {
    const next = applyTreemapCommand({
      model: result.model,
      source: result.source,
      readonly: input.readonly,
      command,
    });
    if (!next.changed && next.diagnosis !== "no-change")
      return {
        ...treemapNoChange(input.model, next.diagnosis),
        source: input.source,
      };
    if (next.changed) result = next;
  }
  return result.source === input.source
    ? { ...treemapNoChange(input.model, "no-change"), source: input.source }
    : result;
}
