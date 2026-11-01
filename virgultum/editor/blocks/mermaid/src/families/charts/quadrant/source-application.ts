// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidQuadrantCommand } from "../../../engine/charts/quadrant/commands/types.js";
import type { MermaidQuadrantModel } from "../../../engine/charts/quadrant/model.js";
import {
  applyMermaidQuadrantSourceCommand,
  type MermaidQuadrantSourceApplyIntent,
  type MermaidQuadrantSourceApplyResult,
} from "../../../engine/charts/quadrant/writer.js";

export type MermaidQuadrantFamilySourceCommand = {
  baseSourceHash?: string;
  command: MermaidQuadrantCommand;
  intent?: MermaidQuadrantSourceApplyIntent;
  model: MermaidQuadrantModel;
  readonly?: boolean;
  source: string;
};

/** Sole apply path: command -> range patch -> identity-aware reparse -> commit. */
export function applyMermaidQuadrantFamilySourceCommand(
  input: MermaidQuadrantFamilySourceCommand,
): MermaidQuadrantSourceApplyResult {
  return applyMermaidQuadrantSourceCommand({
    baseSourceHash: input.baseSourceHash,
    command: input.command,
    intent: input.intent,
    previousModel: input.model,
    readonly: input.readonly,
    source: input.source,
  });
}
