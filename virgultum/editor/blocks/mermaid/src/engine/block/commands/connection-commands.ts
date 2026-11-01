// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../model.js";
import {
  isBlockConnectionToken,
  isBlockConnectionLabelStart,
} from "../config.js";
import { nextBlockSourceKey } from "../source-document.js";
import {
  blockNoChange,
  writeBlockPatches,
  type BlockWriteOptions,
  type BlockPatch,
} from "../writer.js";
import {
  blockObject,
  blockRecord,
  blockQuote,
  blockInsertion,
} from "./block-commands.js";
export type BlockConnectionChanges = {
  from?: string;
  to?: string;
  token?: string;
  startToken?: string;
  label?: string;
  confirmLabelLoss?: boolean;
};
function connectionNotation(token: string, label: string, startToken?: string) {
  if (!isBlockConnectionToken(token) || (token.startsWith("~~~") && label))
    return null;
  if (!label) return token;
  const prefix =
    startToken ??
    (token.includes("==") ? "==" : token.includes(".-") ? "-." : "--");
  return isBlockConnectionLabelStart(prefix)
    ? `${prefix} ${blockQuote(label)} ${token}`
    : null;
}
export function addBlockConnection(
  m: MermaidBlockDiagramModel,
  args: {
    from: string;
    to: string;
    label?: string;
    token?: string;
    parent?: string | null;
  },
  o: BlockWriteOptions = {},
) {
  const from = blockObject(m, args.from),
    to = blockObject(m, args.to),
    notation = connectionNotation(args.token ?? "-->", args.label ?? "");
  if (
    !from ||
    !to ||
    !notation ||
    (!m.nodes.some((n) => n === from) &&
      !m.groups.find((g) => g === from)?.explicitId) ||
    (!m.nodes.some((n) => n === to) &&
      !m.groups.find((g) => g === to)?.explicitId)
  )
    return blockNoChange(m, "invalid");
  const insert = blockInsertion(m, args.parent ?? null);
  if (!insert) return blockNoChange(m, "invalid");
  const key = nextBlockSourceKey(),
    value =
      insert.prefix +
      insert.indent +
      `${from.id} ${notation} ${to.id}` +
      insert.newline;
  return writeBlockPatches(
    m,
    [
      {
        range: { start: insert.start, end: insert.start },
        value,
        identities: [[insert.prefix.length, key]],
      },
    ],
    { ...o, selection: key },
  );
}
export function updateBlockConnection(
  m: MermaidBlockDiagramModel,
  key: string,
  c: BlockConnectionChanges,
  o: BlockWriteOptions = {},
) {
  const edge = m.edges.find((e) => e.sourceKey === key),
    r = blockRecord(m, key);
  if (!edge || !r) return blockNoChange(m, "invalid");
  const token = c.token ?? edge.token,
    label = c.label ?? edge.label;
  if (token.startsWith("~~~") && label && !c.confirmLabelLoss)
    return blockNoChange(m, "invalid");
  const notation = connectionNotation(
    token,
    token.startsWith("~~~") ? "" : label,
    c.startToken ?? edge.startToken,
  );
  if (!notation) return blockNoChange(m, "invalid");
  const patches: BlockPatch[] = [];
  for (const side of ["from", "to"] as const)
    if (c[side] !== undefined && c[side] !== edge[side]) {
      const n = blockObject(m, c[side]!);
      if (!n || m.groups.some((g) => g === n && !g.explicitId))
        return blockNoChange(m, "invalid");
      const endpoint =
        side === "from" ? r.endpoints![0]! : r.endpoints!.at(-1)!;
      // Replace a chained left expression only when reconnect explicitly repairs its native defect.
      patches.push({
        range:
          side === "from" && r.chained
            ? r.values.fromExpression!
            : endpoint.values.id!,
        value: n.id + (side === "from" && r.chained ? " " : ""),
      });
    }
  if (
    c.token !== undefined ||
    c.startToken !== undefined ||
    c.label !== undefined
  ) {
    const last = r.endpoints!.at(-1)!,
      first = r.endpoints![r.endpoints!.length - 2]!;
    const start = first.range.end,
      end = last.range.start;
    patches.push({ range: { start, end }, value: ` ${notation} ` });
  }
  return writeBlockPatches(m, patches, { ...o, selection: key });
}
export function deleteBlockConnection(
  m: MermaidBlockDiagramModel,
  key: string,
  o: BlockWriteOptions = {},
) {
  const r = blockRecord(m, key),
    e = m.edges.find((e) => e.sourceKey === key);
  if (!r || !e) return blockNoChange(m, "invalid");
  const declarations = r
    .endpoints!.filter((n) =>
      [...m.nodes, ...m.groups].some(
        (v) => v.id === n.id && v.recordKeys.every((k) => k === key),
      ),
    )
    .map((n) => m.sourceDocument.source.slice(n.range.start, n.range.end));
  const value =
    declarations.map((n) => r.indent + n).join(m.sourceDocument.newline) +
    (declarations.length ? r.eol : "");
  const comments = m.comments.filter((c) => c.anchorKey === key),
    removed = new Set([key, ...comments.map((c) => c.sourceKey)]);
  return writeBlockPatches(
    m,
    [
      {
        range: { start: r.range.start, end: r.range.end + r.eol.length },
        value,
      },
      ...comments.map((c) => {
        const cr = blockRecord(m, c.sourceKey)!;
        return {
          range: { start: cr.range.start, end: cr.range.end + cr.eol.length },
          value: "",
        };
      }),
    ],
    { ...o, removed },
  );
}
export function renameMermaidBlockDiagramEdge(
  m: MermaidBlockDiagramModel,
  key: string,
  label: string,
) {
  return updateBlockConnection(m, key, { label }).model;
}
export function addMermaidBlockDiagramEdge(
  m: MermaidBlockDiagramModel,
  from: string,
  to: string,
  label = "",
) {
  return addBlockConnection(m, { from, to, label }).model;
}
