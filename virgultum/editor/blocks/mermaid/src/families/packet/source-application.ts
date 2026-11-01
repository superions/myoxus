// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyPacketCommand,
  type MermaidPacketModel,
  type PacketCommand,
} from "../../engine/packet/index.js";
export function applyMermaidPacketFamilySourceCommand(
  model: MermaidPacketModel,
  command: PacketCommand,
  baseSource: string,
  readonly: boolean,
  selection?: string,
) {
  return applyPacketCommand(model, command, {
    baseSource,
    readonly,
    selection,
    focus: selection,
  });
}
