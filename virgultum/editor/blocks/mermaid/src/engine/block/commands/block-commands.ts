// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidBlockDiagramModel,
  MermaidBlockGroup,
  MermaidBlockSpace,
  MermaidBlockNode,
  MermaidBlockNodeSyntax,
  MermaidBlockDirection,
  BlockFieldBinding,
} from "../model.js";
import { SHAPE_SYNTAX, BLOCK_DIRECTIONS, isBlockSpan } from "../config.js";
import {
  readBlockNodeAt,
  nextBlockSourceKey,
  type BlockSourceRecord,
} from "../source-document.js";
import {
  blockNoChange,
  writeBlockPatches,
  type BlockPatch,
  type BlockWriteOptions,
} from "../writer.js";
export function isBlockGroup(
  n: MermaidBlockNode | MermaidBlockGroup | MermaidBlockSpace,
): n is MermaidBlockGroup {
  return "bodyKey" in n;
}
export function isBlockNode(
  n: MermaidBlockNode | MermaidBlockGroup | MermaidBlockSpace,
): n is MermaidBlockNode {
  return "label" in n;
}
export const blockItems = (m: MermaidBlockDiagramModel) => [
  ...m.nodes,
  ...m.groups,
  ...m.spaces,
];
export const blockObject = (m: MermaidBlockDiagramModel, key: string) =>
  [...m.nodes, ...m.groups].find((n) => n.sourceKey === key || n.id === key);
export const blockRecord = (m: MermaidBlockDiagramModel, key: string) =>
  m.sourceDocument.records.find((r) => r.sourceKey === key);
export const blockQuote = (label: string) =>
  `"${label.replaceAll('"', "#quot;")}"`;
export function isBlockId(id: string) {
  const n = readBlockNodeAt(id, 0);
  return Boolean(
    n &&
    n.id === id &&
    n.consumed === id.length &&
    !/^(?:block(?:-beta)?|space|end|columns|default|linkStyle|interpolate)$/.test(
      id,
    ) &&
    !id.startsWith('"'),
  );
}
export function blockEndpoint(
  m: MermaidBlockDiagramModel,
  b: BlockFieldBinding,
) {
  return blockRecord(m, b.sourceKey)?.endpoints?.[b.endpoint];
}
/** Source scope ancestry includes every composite occurrence, even when the
 * native DB has one aggregated visible ID. Geometry never supplies this tree. */
export function blockParentCanContain(
  m: MermaidBlockDiagramModel,
  key: string,
  parent: string | null,
) {
  const group = m.groups.find((g) => g.sourceKey === key);
  if (!group) return true;
  const owned = new Set(
    group.recordKeys.filter((k) => blockRecord(m, k)?.kind === "composite"),
  );
  let scope = parent;
  const seen = new Set<string>();
  while (scope) {
    if (owned.has(scope) || scope === group.sourceKey || seen.has(scope))
      return false;
    seen.add(scope);
    scope = blockRecord(m, scope)?.parentKey ?? null;
  }
  return true;
}
export function blockInsertion(
  m: MermaidBlockDiagramModel,
  parent: string | null,
  before?: string,
) {
  const p = parent
    ? m.groups.find((g) => g.bodyKey === parent || g.sourceKey === parent)
    : undefined;
  if (parent && !p) return null;
  const record =
    before === "$first"
      ? m.sourceDocument.records.find(
          (r) =>
            r.parentKey === (p?.bodyKey ?? null) &&
            ![
              "frontmatter",
              "directive",
              "header",
              "columns",
              "blank",
            ].includes(r.kind),
        )
      : before
        ? (blockItemRecord(m, before) ?? blockRecord(m, before))
        : p
          ? blockRecord(m, blockRecord(m, p.bodyKey)!.closeKey!)
          : undefined;
  if (before && (!record || record.parentKey !== (p?.bodyKey ?? null)))
    return null;
  const source = m.sourceDocument.source,
    start =
      before && record
        ? blockUnitRange(m, record).start
        : (record?.range.start ?? source.length);
  return {
    start,
    indent: p ? (blockRecord(m, p.bodyKey)?.indent ?? "") + "  " : "  ",
    newline: m.sourceDocument.newline,
    prefix:
      start && !/[\r\n]$/.test(source.slice(0, start))
        ? m.sourceDocument.newline
        : "",
  };
}
export function addBlock(
  m: MermaidBlockDiagramModel,
  args: {
    id: string;
    label?: string;
    syntax?: MermaidBlockNodeSyntax;
    parent?: string | null;
    before?: string;
    span?: number;
    directions?: MermaidBlockDirection[];
  },
  o: BlockWriteOptions = {},
) {
  if (
    !isBlockId(args.id) ||
    blockObject(m, args.id) ||
    !isBlockSpan(args.span ?? 1)
  )
    return blockNoChange(m, "invalid");
  const insertion = blockInsertion(m, args.parent ?? null, args.before);
  if (!insertion) return blockNoChange(m, "invalid");
  const shape = blockDeclaration(
    args.id,
    args.label ?? args.id,
    args.syntax ?? "rectangle",
    args.directions ?? ["right"],
    args.span ?? 1,
  );
  if (!shape) return blockNoChange(m, "invalid");
  const key = nextBlockSourceKey(),
    value = insertion.prefix + insertion.indent + shape + insertion.newline;
  return writeBlockPatches(
    m,
    [
      {
        range: { start: insertion.start, end: insertion.start },
        value,
        identities: [[insertion.prefix.length, key]],
      },
    ],
    {
      ...o,
      selection: key,
      impact: { records: [], grids: [args.parent ?? null] },
    },
  );
}
export function blockDeclaration(
  id: string,
  label: string,
  syntax: MermaidBlockNodeSyntax,
  directions: readonly MermaidBlockDirection[],
  span: number,
  custom?: { sourceOpen: string; sourceClose: string },
) {
  const tokens = SHAPE_SYNTAX.find((s) => s.syntax === syntax);
  if (!isBlockSpan(span)) return null;
  if (
    syntax === "block-arrow" &&
    (!directions.length ||
      directions.some((d) => !BLOCK_DIRECTIONS.includes(d)))
  )
    return null;
  const body =
    syntax === "bare" && label === id
      ? id
      : syntax === "block-arrow"
        ? `${id}<[${blockQuote(label)}]>(${directions.join(", ")})`
        : tokens
          ? `${id}${tokens.open}${blockQuote(label)}${tokens.close}`
          : syntax === "custom" && custom
            ? `${id}${custom.sourceOpen}${blockQuote(label)}${custom.sourceClose}`
            : syntax === "bare"
              ? `${id}[${blockQuote(label)}]`
              : null;
  return body === null ? null : body + (span !== 1 ? `:${span}` : "");
}
export function updateBlock(
  m: MermaidBlockDiagramModel,
  key: string,
  changes: {
    id?: string;
    label?: string;
    syntax?: MermaidBlockNodeSyntax;
    span?: number;
    directions?: MermaidBlockDirection[];
  },
  o: BlockWriteOptions = {},
): import("../writer.js").BlockCommandResult {
  const n = blockObject(m, key);
  if (!n) return blockNoChange(m, "invalid");
  const patches: BlockPatch[] = [];
  if (
    isBlockGroup(n) &&
    !n.explicitId &&
    (changes.id !== undefined ||
      changes.label !== undefined ||
      changes.syntax !== undefined)
  ) {
    if (!changes.id || !isBlockId(changes.id) || blockObject(m, changes.id))
      return blockNoChange(m, "invalid");
    const r = blockRecord(m, n.bodyKey)!,
      header = blockDeclaration(
        changes.id,
        changes.label ?? changes.id,
        changes.syntax ?? "rectangle",
        [],
        changes.span ?? n.span,
      );
    if (!header) return blockNoChange(m, "invalid");
    return writeBlockPatches(
      m,
      [{ range: r.range, value: r.indent + "block:" + header }],
      {
        ...o,
        selection: n.sourceKey,
        impact: {
          records: [],
          grids: changes.span !== undefined ? [n.parentKey] : [],
        },
      },
    );
  }
  if (changes.id !== undefined && changes.id !== n.id) {
    if (
      !isBlockId(changes.id) ||
      blockObject(m, changes.id) ||
      (!/^\w+$/.test(changes.id) &&
        m.sourceDocument.records.some(
          (r) =>
            ["class", "style"].includes(r.kind) &&
            r.references.some((ref) => ref.id === n.id),
        ))
    )
      return blockNoChange(m, "invalid");
    // Exact reference ranges cover every declaration, inline endpoint and class/style target.
    for (const r of m.sourceDocument.records)
      for (const ref of r.references)
        if (ref.id === n.id)
          patches.push({ range: ref.range, value: changes.id });
  }
  if (changes.label !== undefined && changes.label !== n.label) {
    if (!changes.label) return blockNoChange(m, "invalid");
    const e =
      blockEndpoint(m, n.providers.label) ??
      n.recordKeys
        .map((k) => blockRecord(m, k)?.endpoints?.find((e) => e.id === n.id))
        .find(Boolean);
    if (e?.values.label)
      patches.push({
        range: e.values.label,
        value: changes.label.replaceAll('"', "#quot;"),
      });
    else if (e)
      patches.push({
        range: { start: e.values.id!.end, end: e.values.id!.end },
        value: `[${blockQuote(changes.label)}]`,
      });
    else return blockNoChange(m, "invalid");
  }
  if (
    (changes.syntax !== undefined && changes.syntax !== n.syntax) ||
    (changes.directions !== undefined &&
      JSON.stringify(changes.directions) !== JSON.stringify(n.directions))
  ) {
    const e = blockEndpoint(m, n.providers.shape),
      r = blockRecord(m, n.providers.shape.sourceKey);
    if (!e || !r) return blockNoChange(m, "invalid");
    const syntax = changes.syntax ?? n.syntax,
      directions = changes.directions ?? n.directions;
    const declaration = blockDeclaration(
      e.id,
      changes.label ?? n.label,
      syntax,
      directions,
      e.span,
      e,
    );
    if (!declaration) return blockNoChange(m, "invalid");
    // Own only the body; the ID/span patches and surrounding whitespace stay independent.
    const end = e.values.span ? e.values.span.start - 1 : e.range.end;
    const bodyEnd =
      declaration.length - (e.span !== 1 ? `:${e.span}`.length : 0);
    const owned = { start: e.values.id!.end, end };
    for (let i = patches.length - 1; i >= 0; i--)
      if (
        patches[i]!.range.start >= owned.start &&
        patches[i]!.range.end <= owned.end
      )
        patches.splice(i, 1);
    patches.push({
      range: owned,
      value: declaration.slice(e.id.length, bodyEnd),
    });
  }
  if (
    changes.directions !== undefined &&
    JSON.stringify(changes.directions) !== JSON.stringify(n.directions) &&
    n.providers.directions.sourceKey !== n.providers.shape.sourceKey
  ) {
    const e = blockEndpoint(m, n.providers.directions);
    if (!e) return blockNoChange(m, "invalid");
    const declaration = blockDeclaration(
      e.id,
      e.label,
      "block-arrow",
      changes.directions,
      e.span,
      e,
    );
    if (!declaration) return blockNoChange(m, "invalid");
    const owned = {
      start: e.values.id!.end,
      end: e.values.span ? e.values.span.start - 1 : e.range.end,
    };
    for (let i = patches.length - 1; i >= 0; i--)
      if (
        patches[i]!.range.start >= owned.start &&
        patches[i]!.range.end <= owned.end
      )
        patches.splice(i, 1);
    patches.push({
      range: owned,
      value: declaration.slice(
        e.id.length,
        declaration.length - (e.span !== 1 ? `:${e.span}`.length : 0),
      ),
    });
  }
  if (changes.span !== undefined && changes.span !== n.span) {
    if (!isBlockSpan(changes.span)) return blockNoChange(m, "invalid");
    const spanRecord = blockRecord(m, n.providers.span.sourceKey);
    if (spanRecord?.kind === "connection") {
      const prepared = materializeBlockEndpoints(m, spanRecord, o);
      if (!prepared.changed) return prepared;
      const updated = updateBlock(prepared.model, key, changes, {
        ...o,
        baseSource: prepared.source,
      });
      return updated.status === "rejected"
        ? updated
        : {
            ...updated,
            changed: true,
            status: "changed",
            source: updated.source,
          };
    }
    const e = blockEndpoint(m, n.providers.span);
    if (!e) return blockNoChange(m, "invalid");
    if (e.values.span)
      patches.push({ range: e.values.span, value: String(changes.span) });
    else
      patches.push({
        range: { start: e.range.end, end: e.range.end },
        value: `:${changes.span}`,
      });
  }
  return writeBlockPatches(m, patches, {
    ...o,
    selection: n.sourceKey,
    impact: {
      records: [],
      grids: changes.span !== undefined ? [n.parentKey] : [],
    },
  });
}
export function blockItemRecord(m: MermaidBlockDiagramModel, key: string) {
  const item = blockItems(m).find((n) => n.sourceKey === key);
  return item
    ? blockRecord(
        m,
        isBlockGroup(item)
          ? item.bodyKey
          : isBlockNode(item)
            ? (item.recordKeys.find((k) =>
                ["block", "connection"].includes(blockRecord(m, k)?.kind ?? ""),
              ) ?? item.recordKeys[0]!)
            : item.sourceKey,
      )
    : undefined;
}
export function blockUnitRange(
  m: MermaidBlockDiagramModel,
  r: BlockSourceRecord,
  comments = true,
) {
  const close = r.closeKey ? blockRecord(m, r.closeKey) : r;
  let start = r.range.start,
    end =
      (close?.range.end ?? r.range.end) + (close?.eol.length ?? r.eol.length);
  if (comments)
    for (const c of m.comments.filter((c) => c.anchorKey === r.sourceKey)) {
      const cr = blockRecord(m, c.sourceKey)!;
      start = Math.min(start, cr.range.start);
      end = Math.max(end, cr.range.end + cr.eol.length);
    }
  return { start, end };
}
export function blockDeleteImpact(m: MermaidBlockDiagramModel, key: string) {
  const n = blockObject(m, key),
    records = m.sourceDocument.records.filter(
      (r) =>
        r.sourceKey === key ||
        n?.recordKeys.includes(r.sourceKey) ||
        r.references.some((ref) => ref.id === n?.id),
    );
  const comments = m.comments.filter((c) =>
    records.some((r) => r.sourceKey === c.anchorKey),
  );
  return {
    records: [
      ...records,
      ...comments.map((c) => blockRecord(m, c.sourceKey)!),
    ].map((r) => ({ id: r.sourceKey, kind: r.kind, label: r.raw.trim() })),
    grids: n ? [n.parentKey] : [],
  };
}
export function deleteBlock(
  m: MermaidBlockDiagramModel,
  key: string,
  o: BlockWriteOptions = {},
) {
  const n = blockObject(m, key);
  if (!n || m.groups.includes(n as never)) return blockNoChange(m, "invalid");
  const impact = blockDeleteImpact(m, n.sourceKey),
    removed = new Set(impact.records.map((r) => r.id));
  const ranges = m.sourceDocument.records
    .filter((r) => removed.has(r.sourceKey))
    .map((r) => blockUnitRange(m, r, false));
  // Materialize unrelated implicit endpoints before removing their only owning connection.
  const surviving = m.nodes.filter(
    (v) => v.id !== n.id && v.recordKeys.every((k) => removed.has(k)),
  );
  const addition = surviving
    .map((v) =>
      blockDeclaration(v.id, v.label, v.syntax, v.directions, v.span, v),
    )
    .join("\n");
  const patches: BlockPatch[] = blockDeletionPatches(m, removed, ranges);
  if (addition && ranges.length)
    patches[0]!.value = addition + m.sourceDocument.newline;
  return writeBlockPatches(m, patches, { ...o, removed, impact });
}
export function renameMermaidBlockDiagramNode(
  m: MermaidBlockDiagramModel,
  id: string,
  label: string,
) {
  return updateBlock(m, id, { label }).model;
}

/** Multiple selected objects compose in memory and reach the host as one write. */
export function deleteBlockSelection(
  m: MermaidBlockDiagramModel,
  keys: readonly string[],
  o: BlockWriteOptions = {},
) {
  if (o.readonly) return blockNoChange(m, "readonly");
  if (o.intent === "cancel") return blockNoChange(m, "cancelled");
  if (!keys.length) return blockNoChange(m);
  if (
    keys.some(
      (k) =>
        !blockItems(m).some((n) => n.sourceKey === k) &&
        !m.edges.some((e) => e.sourceKey === k),
    )
  )
    return blockNoChange(m, "invalid");
  let current = m,
    changed = false;
  const records = new Map<
      string,
      { id: string; kind: string; label: string }
    >(),
    grids = new Set<string | null>();
  for (const key of new Set(keys)) {
    const item = blockItems(current).find((n) => n.sourceKey === key);
    let result: import("../writer.js").BlockCommandResult | undefined;
    if (item && isBlockGroup(item))
      result = deleteBlockComposite(current, key, { children: "delete" });
    else if (item && isBlockNode(item)) result = deleteBlock(current, key);
    else if (item) result = deleteBlockSpace(current, key);
    else if (current.edges.some((e) => e.sourceKey === key))
      result = deleteBlockConnection(current, key);
    else continue;
    if (result.status === "rejected")
      return {
        ...blockNoChange(m, result.reason, result.diagnostic),
        impact: result.impact,
      };
    current = result.model;
    changed ||= result.changed;
    for (const r of result.impact.records) records.set(r.id, r);
    for (const g of result.impact.grids) grids.add(g);
  }
  return {
    changed,
    status: changed ? "changed" : "no-op",
    source: current.sourceDocument.source,
    model: current,
    patches: [],
    reason: changed ? "applied" : "no-change",
    impact: { records: [...records.values()], grids: [...grids] },
  } as import("../writer.js").BlockCommandResult;
}
import { deleteBlockComposite } from "./composite-commands.js";
import { deleteBlockSpace } from "./space-commands.js";
import { deleteBlockConnection } from "./connection-commands.js";

/** Deleting owned records merges contained comment ranges and keeps each newly
 * empty grammar body valid with a columns directive, never a synthetic child. */
export function blockDeletionPatches(
  m: MermaidBlockDiagramModel,
  removed: ReadonlySet<string>,
  ranges: readonly { start: number; end: number }[],
): BlockPatch[] {
  const merged: { start: number; end: number }[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const patches: BlockPatch[] = merged.map((range) => ({ range, value: "" }));
  for (const parent of [
    null,
    ...m.sourceDocument.records
      .filter((r) => r.kind === "composite" && !removed.has(r.sourceKey))
      .map((r) => r.sourceKey),
  ]) {
    if (
      m.sourceDocument.records.some(
        (r) =>
          r.parentKey === parent &&
          !removed.has(r.sourceKey) &&
          ![
            "header",
            "frontmatter",
            "directive",
            "comment",
            "blank",
            "end",
          ].includes(r.kind),
      )
    )
      continue;
    const owned = m.sourceDocument.records.filter(
      (r) => r.parentKey === parent && removed.has(r.sourceKey),
    );
    const at = owned.find((r) =>
      patches.some(
        (p) => p.range.start <= r.range.start && p.range.end >= r.range.end,
      ),
    );
    if (at) {
      const patch = patches.find(
        (p) => p.range.start <= at.range.start && p.range.end >= at.range.end,
      )!;
      patch.value += at.indent + "columns auto" + m.sourceDocument.newline;
    }
  }
  return patches;
}
/** First inline endpoints have native implicit span one. An explicit statement
 * is required before the connection for a span or grid-position command to own
 * that first placement. The connection and all its tokens stay byte-identical. */
export function materializeBlockEndpoints(
  m: MermaidBlockDiagramModel,
  r: BlockSourceRecord,
  o: BlockWriteOptions = {},
): import("../writer.js").BlockCommandResult {
  if (r.kind !== "connection" || r.chained) return blockNoChange(m, "invalid");
  const nodes = [...m.nodes, ...m.groups].filter(
      (n) => n.recordKeys[0] === r.sourceKey,
    ),
    identities: Array<readonly [number, string]> = [];
  let value = "";
  for (const n of nodes) {
    const endpoint = r.endpoints?.find((e) => e.id === n.id);
    if (!endpoint) return blockNoChange(m, "invalid");
    const declaration = blockDeclaration(
      n.id,
      endpoint.label,
      endpoint.syntax,
      endpoint.directions,
      n.span,
      endpoint,
    );
    if (!declaration) return blockNoChange(m, "invalid");
    identities.push([value.length, nextBlockSourceKey()]);
    value += r.indent + declaration + m.sourceDocument.newline;
  }
  if (!value) return blockNoChange(m);
  return writeBlockPatches(
    m,
    [
      {
        range: { start: r.range.start, end: r.range.start },
        value,
        identities,
      },
    ],
    {
      ...o,
      commentTransfers: new Set(
        m.comments
          .filter((c) => c.anchorKey === r.sourceKey)
          .map((c) => c.sourceKey),
      ),
    },
  );
}
