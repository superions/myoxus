// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MermaidPieCommand } from "../../../engine/charts/pie/commands.js";
import type { MermaidPieModel } from "../../../engine/charts/pie/model.js";
import {
  applyMermaidPieSourceCommand,
  type MermaidPieSourceApplyIntent,
  type MermaidPieSourceApplyResult,
} from "../../../engine/charts/pie/writer.js";

export type MermaidPieFamilySourceCommand = {
  readonly baseSourceHash?: string;
  readonly command: MermaidPieCommand;
  readonly intent?: MermaidPieSourceApplyIntent;
  readonly model: MermaidPieModel;
  readonly readonly?: boolean;
  readonly source: string;
};

/** The sole Pie apply path: command -> range patch -> reparse -> host commit. */
export function applyMermaidPieFamilySourceCommand(
  input: MermaidPieFamilySourceCommand,
): MermaidPieSourceApplyResult {
  return applyMermaidPieSourceCommand({
    baseSourceHash: input.baseSourceHash,
    command: input.command,
    intent: input.intent,
    previousModel: input.model,
    readonly: input.readonly,
    source: input.source,
  });
}
