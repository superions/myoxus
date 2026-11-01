// SPDX-License-Identifier: AGPL-3.0-or-later

import { applyMermaidRadarAxisCommand } from "../../../engine/charts/radar/commands/axis.js";
import { applyMermaidRadarCommentCommand } from "../../../engine/charts/radar/commands/comment.js";
import { applyMermaidRadarConfigCommand } from "../../../engine/charts/radar/commands/config.js";
import { applyMermaidRadarCurveCommand } from "../../../engine/charts/radar/commands/curve.js";
import { applyMermaidRadarMetadataCommand } from "../../../engine/charts/radar/commands/metadata.js";
import { applyMermaidRadarOptionsCommand } from "../../../engine/charts/radar/commands/options.js";
import type {
  MermaidRadarCommand,
  MermaidRadarCommandResult,
} from "../../../engine/charts/radar/commands/types.js";
import { applyMermaidRadarVertexCommand } from "../../../engine/charts/radar/commands/vertex.js";
import type { MermaidRadarModel } from "../../../engine/charts/radar/model.js";
import { radarNoChange } from "../../../engine/charts/radar/writer.js";
import { hashMermaidSource } from "../../../utils.js";

export type MermaidRadarFamilySourceCommand = {
  readonly baseSourceHash?: string;
  readonly command: MermaidRadarCommand;
  readonly model: MermaidRadarModel;
  readonly readonly?: boolean;
  readonly source: string;
};

/** Sole Radar mutation boundary: typed intent, minimal source patch, anchored reparse. */
export function applyMermaidRadarFamilySourceCommand(
  input: MermaidRadarFamilySourceCommand,
): MermaidRadarCommandResult {
  if (input.readonly)
    return radarNoChange(input.model, input.source, "radar.readonly");
  if (
    input.baseSourceHash !== undefined &&
    input.baseSourceHash !== input.model.sourceHash
  )
    return radarNoChange(input.model, input.source, "radar.stale-source");
  if (hashMermaidSource(input.source) !== input.model.sourceHash)
    return radarNoChange(input.model, input.source, "radar.stale-source");
  const context = {
    command: input.command,
    model: input.model,
    source: input.source,
  };
  if (input.command.type.startsWith("axis."))
    return applyMermaidRadarAxisCommand(context);
  if (input.command.type.startsWith("curve."))
    return applyMermaidRadarCurveCommand(context);
  if (input.command.type.startsWith("vertex."))
    return applyMermaidRadarVertexCommand(context);
  if (input.command.type.startsWith("options."))
    return applyMermaidRadarOptionsCommand(context);
  if (input.command.type.startsWith("config."))
    return applyMermaidRadarConfigCommand(context);
  if (input.command.type.startsWith("diagram."))
    return applyMermaidRadarMetadataCommand(context);
  if (input.command.type.startsWith("comment."))
    return applyMermaidRadarCommentCommand(context);
  return radarNoChange(input.model, input.source, "radar.command-invalid");
}
