// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../model.js";
import { isBlockSpan } from "../config.js";
import { nextBlockSourceKey } from "../source-document.js";
import {
  blockNoChange,
  writeBlockPatches,
  type BlockWriteOptions,
} from "../writer.js";
import {
  blockInsertion,
  blockRecord,
  blockUnitRange,
  blockDeletionPatches,
} from "./block-commands.js";
export function addBlockSpace(
  m: MermaidBlockDiagramModel,
  args: { parent?: string | null; before?: string; span?: number },
  o: BlockWriteOptions = {},
) {
  const span = args.span ?? 1;
  if (!isBlockSpan(span)) return blockNoChange(m, "invalid");
  const i = blockInsertion(m, args.parent ?? null, args.before);
  if (!i) return blockNoChange(m, "invalid");
  const key = nextBlockSourceKey();
  return writeBlockPatches(
    m,
    [
      {
        range: { start: i.start, end: i.start },
        value:
          i.prefix +
          i.indent +
          `space${span === 1 ? "" : `:${span}`}` +
          i.newline,
        identities: [[i.prefix.length, key]],
      },
    ],
    {
      ...o,
      selection: key,
      impact: { records: [], grids: [args.parent ?? null] },
    },
  );
}
export function updateBlockSpace(
  m: MermaidBlockDiagramModel,
  key: string,
  span: number,
  o: BlockWriteOptions = {},
) {
  const n = m.spaces.find((s) => s.sourceKey === key),
    r = blockRecord(m, key);
  if (!n || !r || !isBlockSpan(span)) return blockNoChange(m, "invalid");
  if (n.span === span) return blockNoChange(m);
  const range = r.values.span ?? { start: r.range.end, end: r.range.end };
  return writeBlockPatches(
    m,
    [{ range, value: r.values.span ? String(span) : `:${span}` }],
    { ...o, selection: key, impact: { records: [], grids: [n.parentKey] } },
  );
}
export function deleteBlockSpace(
  m: MermaidBlockDiagramModel,
  key: string,
  o: BlockWriteOptions = {},
) {
  const r = blockRecord(m, key);
  if (r?.kind !== "space") return blockNoChange(m, "invalid");
  const range = blockUnitRange(m, r),
    removed = new Set(
      m.sourceDocument.records
        .filter(
          (r) => r.range.start >= range.start && r.range.start < range.end,
        )
        .map((r) => r.sourceKey),
    );
  return writeBlockPatches(m, blockDeletionPatches(m, removed, [range]), {
    ...o,
    removed,
    impact: { records: [], grids: [r.parentKey] },
  });
}
