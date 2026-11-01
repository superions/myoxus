// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyCommand } from "../../../engine/charts/xy/commands/types.js";
import type { MermaidXyModel } from "../../../engine/charts/xy/model.js";
import {
  applyMermaidXySourceCommand,
  type MermaidXySourceApplyIntent,
  type MermaidXySourceApplyResult,
} from "../../../engine/charts/xy/writer.js";

export type MermaidXyFamilySourceCommand = {
  baseSourceHash?: string;
  command: MermaidXyCommand;
  intent?: MermaidXySourceApplyIntent;
  model: MermaidXyModel;
  readonly?: boolean;
  source: string;
};

/** Sole XY mutation path: typed command, range patch, identity-aware reparse. */
export function applyMermaidXyFamilySourceCommand(
  input: MermaidXyFamilySourceCommand,
): MermaidXySourceApplyResult {
  return applyMermaidXySourceCommand({
    baseSourceHash: input.baseSourceHash,
    command: input.command,
    intent: input.intent,
    previousModel: input.model,
    readonly: input.readonly,
    source: input.source,
  });
}
