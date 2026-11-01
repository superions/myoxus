// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommandContext,
  MermaidRadarConfigCommand,
} from "./types.js";
import { mermaidRadarConfigDiagnosis } from "../model.js";
import {
  radarConfigPatches,
  radarNoChange,
  radarPatchedResult,
} from "../writer.js";

export function applyMermaidRadarConfigCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarConfigCommand;
  if (command.type !== "config.apply")
    return radarNoChange(
      context.model,
      context.source,
      "radar.command-invalid",
    );
  const diagnosis = mermaidRadarConfigDiagnosis(command.config);
  if (diagnosis) return radarNoChange(context.model, context.source, diagnosis);
  return radarPatchedResult({
    model: context.model,
    patches: radarConfigPatches(context.model, command.config),
    selectionAfter: null,
    source: context.source,
  });
}
