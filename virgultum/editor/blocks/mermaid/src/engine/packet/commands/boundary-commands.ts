// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../../i18n.js";
import type { MermaidPacketModel, MermaidPacketField } from "../model.js";
import {
  packetFieldNumberPatches,
  packetNoChange,
  writePacketPatches,
  type PacketPatch,
  type PacketWriteOptions,
} from "../writer.js";

/** A range draft changes the two adjoining boundaries atomically against one Source.
 * Unselected neighbours keep their far boundary; the first bit always remains zero. */
export function planPacketFieldRange(
  model: MermaidPacketModel,
  fieldKey: string,
  startBit: number,
  endBit: number,
  sourceForm?: MermaidPacketField["sourceForm"],
):
  | { patches: PacketPatch[]; diagnostic?: undefined }
  | { patches?: undefined; diagnostic: string } {
  const index = model.fields.findIndex((f) => f.id === fieldKey),
    field = model.fields[index];
  if (!field) return { diagnostic: messages.packetMissingField() };
  const previous = model.fields[index - 1],
    next = model.fields[index + 1];
  const min = previous ? previous.startBit + 1 : 0,
    max = next ? next.endBit - 1 : Number.MAX_SAFE_INTEGER - 1;
  if (
    !Number.isSafeInteger(startBit) ||
    !Number.isSafeInteger(endBit + 1) ||
    startBit < min ||
    endBit > max ||
    startBit > endBit ||
    (!previous && startBit !== 0)
  )
    return {
      diagnostic: previous
        ? messages.packetRangeBounds(min, max)
        : messages.packetFirstRangeBounds(min, max),
    };
  const patches: PacketPatch[] = [];
  for (const [item, start, end, form] of [
    [previous, previous?.startBit, startBit - 1, undefined],
    [field, startBit, endBit, sourceForm],
    [next, endBit + 1, next?.endBit, undefined],
  ] as const) {
    if (!item || start === undefined || end === undefined) continue;
    const change = packetFieldNumberPatches(item, start, end, form);
    if (!change)
      return {
        diagnostic: messages.packetMissingFieldRanges(),
      };
    patches.push(...change);
  }
  return { patches };
}
export function moveBoundary(
  model: MermaidPacketModel,
  leftKey: string,
  rightKey: string,
  nextBoundary: number,
  options: PacketWriteOptions = {},
) {
  const index = model.fields.findIndex((f) => f.id === leftKey),
    left = model.fields[index],
    right = model.fields[index + 1];
  if (!left || right?.id !== rightKey)
    return packetNoChange(model, "invalid", messages.packetBoundaryNeighbors());
  if (
    !Number.isSafeInteger(nextBoundary) ||
    nextBoundary < left.startBit + 1 ||
    nextBoundary > right.endBit
  )
    return packetNoChange(
      model,
      "invalid",
      messages.packetBoundaryBounds(left.startBit + 1, right.endBit),
    );
  const plan = planPacketFieldRange(
    model,
    leftKey,
    left.startBit,
    nextBoundary - 1,
  );
  return plan.patches
    ? writePacketPatches(model, plan.patches, {
        ...options,
        selection: options.selection ?? leftKey,
        focus: options.focus ?? leftKey,
      })
    : packetNoChange(model, "invalid", plan.diagnostic);
}
export function resizePacketEnd(
  model: MermaidPacketModel,
  fieldKey: string,
  nextEnd: number,
  options: PacketWriteOptions = {},
) {
  const field = model.fields.at(-1);
  if (!field || field.id !== fieldKey)
    return packetNoChange(model, "invalid", messages.packetEndOnly());
  const plan = planPacketFieldRange(model, fieldKey, field.startBit, nextEnd);
  return plan.patches
    ? writePacketPatches(model, plan.patches, {
        ...options,
        selection: fieldKey,
        focus: fieldKey,
      })
    : packetNoChange(model, "invalid", plan.diagnostic);
}
