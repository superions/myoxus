// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import type { PacketConfig } from "./config.js";
import { packetSourceDiagnostic } from "./diagnostics.js";
import type {
  MermaidPacketField,
  MermaidPacketLayoutIssue,
  MermaidPacketModel,
} from "./model.js";
export function validatePacketFieldRanges(
  fields: readonly MermaidPacketField[],
) {
  const issues: MermaidPacketLayoutIssue[] = [];
  const valid = fields.filter((field) => {
    if (field.endBit >= field.startBit) return true;
    issues.push({
      code: "invalid-range",
      endBit: field.endBit,
      fieldIds: [field.id],
      startBit: field.startBit,
    });
    return false;
  });
  let cursor = 0;
  for (const field of valid) {
    if (field.startBit > cursor) {
      issues.push({
        code: "gap",
        endBit: field.startBit - 1,
        fieldIds: [field.id],
        expectedStart: cursor,
        startBit: cursor,
      });
    } else if (field.startBit < cursor) {
      const overlapping = valid
        .filter(
          (candidate) =>
            candidate.id !== field.id &&
            candidate.startBit <= field.endBit &&
            candidate.endBit >= field.startBit,
        )
        .map((candidate) => candidate.id);
      issues.push({
        code: "overlap",
        expectedStart: cursor,
        endBit: Math.min(cursor - 1, field.endBit),
        fieldIds: [field.id, ...overlapping].filter(
          (id, index, values) => values.indexOf(id) === index,
        ),
        startBit: field.startBit,
      });
    }
    cursor = Math.max(cursor, field.endBit + 1);
  }
  return { issues, totalWidth: cursor };
}

export type PacketFieldFragment = {
  fieldId: string;
  row: number;
  columnStart: number;
  columnEnd: number;
  startBit: number;
  endBit: number;
  fieldStartBit: number;
  fieldEndBit: number;
  label: string;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Only real field ends own a boundary, never an incidental Row seam. */
  boundary?: {
    leftKey: string;
    rightKey?: string;
    bit: number;
    min: number;
    max: number;
  };
};
export type PacketLayoutRow = {
  row: number;
  startBit: number;
  endBit: number;
  fragments: PacketFieldFragment[];
};
export type PacketRowLayout = {
  rows: PacketLayoutRow[];
  totalWidth: number;
  rowCount: number;
  config: PacketConfig | null;
  derivedPaddingY: number | null;
  mutableGeometry: boolean;
  diagnostic?: string;
};
/** Shared semantic projection for confirmed models and transient command previews.
 * Materialization is bounded before allocating Rows; source positions remain absolute. */
export function layoutPacket(model: MermaidPacketModel): PacketRowLayout {
  const { config, derivedPaddingY, mutableGeometry } = model.configResolution;
  const totalWidth = model.fields.at(-1) ? model.fields.at(-1)!.endBit + 1 : 0;
  const rowCount = config ? Math.ceil(totalWidth / config.bitsPerRow) : 0;
  const result: PacketRowLayout = {
    rows: [],
    totalWidth,
    rowCount,
    config,
    derivedPaddingY,
    mutableGeometry,
  };
  if (model.issues.length || model.diagnostics.length)
    return {
      ...result,
      mutableGeometry: false,
      diagnostic: packetSourceDiagnostic(model) ?? undefined,
    };
  if (!config || !mutableGeometry)
    return {
      ...result,
      diagnostic: messages.packetGeometryUnavailable(),
    };
  const guard = packetMaterializationDiagnostic(
    totalWidth,
    config,
    derivedPaddingY,
  );
  if (guard) return { ...result, mutableGeometry: false, diagnostic: guard };
  for (let row = 0; row < rowCount; row++)
    result.rows.push({
      row,
      startBit: row * config.bitsPerRow,
      endBit: Math.min(totalWidth - 1, (row + 1) * config.bitsPerRow - 1),
      fragments: [],
    });
  for (let index = 0; index < model.fields.length; index++) {
    const field = model.fields[index]!,
      next = model.fields[index + 1];
    const first = Math.floor(field.startBit / config.bitsPerRow),
      last = Math.floor(field.endBit / config.bitsPerRow);
    for (let row = first; row <= last; row++) {
      const startBit = Math.max(field.startBit, row * config.bitsPerRow),
        endBit = Math.min(field.endBit, (row + 1) * config.bitsPerRow - 1);
      result.rows[row]!.fragments.push({
        fieldId: field.id,
        row,
        startBit,
        endBit,
        fieldStartBit: field.startBit,
        fieldEndBit: field.endBit,
        label: field.label,
        columnStart: startBit - row * config.bitsPerRow,
        columnEnd: endBit - row * config.bitsPerRow,
        continuesBefore: row > first,
        continuesAfter: row < last,
        boundary:
          row === last
            ? {
                leftKey: field.id,
                rightKey: next?.id,
                bit: field.endBit + 1,
                min: field.startBit + 1,
                max: next ? next.endBit : Number.MAX_SAFE_INTEGER,
              }
            : undefined,
      });
    }
  }
  return result;
}

/** One preallocation guard is shared by parser/native preview and Row layout. */
export function packetMaterializationDiagnostic(
  totalWidth: number,
  config: PacketConfig,
  paddingY: number | null,
) {
  const rows = Math.ceil(totalWidth / config.bitsPerRow);
  return !Number.isSafeInteger(rows) ||
    rows > 10000 ||
    !Number.isFinite(config.bitWidth * config.bitsPerRow) ||
    !Number.isFinite(rows * (config.rowHeight + (paddingY ?? 0)))
    ? messages.packetMaterialization()
    : undefined;
}
