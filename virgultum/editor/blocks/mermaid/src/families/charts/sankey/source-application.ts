// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applySankeyCommand,
  type SankeyCommand,
} from "../../../engine/charts/sankey/commands/index.js";
import type { SankeyModel } from "../../../engine/charts/sankey/model.js";
import {
  sankeyNoChange,
  type SankeyCommandResult,
} from "../../../engine/charts/sankey/writer.js";

/** Stage an entire intent batch before the host's single history transaction.
 * A rejected later field must not persist an earlier successful field edit. */
export function applyMermaidSankeyFamilySourceCommand(input: {
  readonly model: SankeyModel;
  readonly source: string;
  readonly readonly: boolean;
  readonly command: SankeyCommand | readonly SankeyCommand[];
}): SankeyCommandResult {
  const commands: readonly SankeyCommand[] = Array.isArray(input.command)
    ? input.command
    : [input.command as SankeyCommand];
  let result = {
    ...sankeyNoChange(input.model, "no-change"),
    source: input.source,
  };
  for (const command of commands) {
    const next = applySankeyCommand({
      model: result.model,
      source: result.source,
      readonly: input.readonly,
      command,
    });
    if (!next.changed && next.diagnosis !== "no-change")
      return {
        ...sankeyNoChange(input.model, next.diagnosis),
        source: input.source,
      };
    if (next.changed) result = next;
  }
  return result.source === input.source
    ? { ...sankeyNoChange(input.model, "no-change"), source: input.source }
    : result;
}
