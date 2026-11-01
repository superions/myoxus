// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateModel } from "./model.js";
import { mermaidMessages as messages } from "../../i18n.js";
import { resolveMermaidStateSource } from "./parser.js";
import { stateSourceDiagnostic } from "./diagnostics.js";
import type { StateSourceRecord } from "./source-document.js";
import { stateDisplayText } from "./source-document.js";
import type { StateComment } from "./model.js";
import type { SourceValuePatch } from "../source-yaml.js";

export type StatePatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type StateImpact = {
  records: readonly { id: string; kind: string; label: string }[];
};
export type StateCommandResult = {
  status: "changed" | "rejected" | "no-op";
  changed: boolean;
  source: string;
  model: MermaidStateModel;
  patches: readonly StatePatch[];
  reason:
    "applied" | "no-change" | "conflict" | "invalid" | "readonly" | "cancelled";
  diagnostic?: string;
  selection?: string;
  focus?: string;
  remap: ReadonlyMap<string, string>;
  impact: StateImpact;
};
export type StateWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "confirm" | "preview" | "cancel";
  removed?: ReadonlySet<string>;
  stateKeys?: ReadonlyMap<string, string>;
  commentTransfers?: ReadonlySet<string>;
  commentAnchors?: ReadonlyMap<
    string,
    Pick<StateComment, "anchorKind" | "anchorId" | "position">
  >;
  selection?: string;
  focus?: string;
  impact?: StateImpact;
};
export function stateNoChange(
  model: MermaidStateModel,
  reason: StateCommandResult["reason"] = "no-change",
  diagnostic?: string,
): StateCommandResult {
  return {
    status:
      reason === "no-change" || reason === "cancelled" ? "no-op" : "rejected",
    changed: false,
    source: model.sourceDocument.source,
    model,
    patches: [],
    reason,
    diagnostic,
    remap: new Map(),
    impact: { records: [] },
  };
}
/** Exact basis validation and candidate reparse precede the sole host transaction.
 * Reserved record starts carry identity across equal signatures and moved units. */
export function writeStatePatches(
  model: MermaidStateModel,
  patches: readonly StatePatch[],
  options: StateWriteOptions = {},
): StateCommandResult {
  const source = model.sourceDocument.source;
  if (options.intent === "cancel") return stateNoChange(model, "cancelled");
  if (options.readonly) return stateNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return stateNoChange(model, "conflict", messages.stateSourceConflict());
  const sorted = [...patches].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>(),
    reserved = new Set<string>();
  let next = "",
    cursor = 0;
  for (const patch of sorted) {
    if (
      !Number.isSafeInteger(patch.range.start) ||
      !Number.isSafeInteger(patch.range.end) ||
      patch.range.start < cursor ||
      patch.range.end < patch.range.start ||
      patch.range.end > source.length
    )
      return stateNoChange(model, "invalid", messages.classPatchRejected());
    next += source.slice(cursor, patch.range.start);
    for (const [offset, id] of patch.identities ?? []) {
      if (offset < 0 || offset > patch.value.length || reserved.has(id))
        return stateNoChange(model, "invalid", messages.classPatchRejected());
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  if (next === source) return stateNoChange(model);
  for (const record of model.sourceDocument.records) {
    if (
      reserved.has(record.sourceKey) ||
      options.removed?.has(record.sourceKey)
    )
      continue;
    let offset = record.range.start,
      removed = false;
    for (const patch of sorted) {
      if (patch.range.start > record.range.start) break;
      if (
        patch.range.end > patch.range.start &&
        record.range.start >= patch.range.start &&
        record.range.start < patch.range.end
      ) {
        if (
          patch.range.start === record.range.start &&
          patch.value &&
          patch.range.end <= record.range.end
        )
          break;
        removed = true;
        break;
      }
      offset += patch.value.length - (patch.range.end - patch.range.start);
    }
    if (!removed) mapping.set(offset, record.sourceKey);
  }
  const resolution = resolveMermaidStateSource(
    next,
    options.commentTransfers?.size
      ? {
          ...model,
          commentRecords: model.commentRecords.filter(
            (c) => !options.commentTransfers!.has(c.id),
          ),
        }
      : model,
    mapping,
    options.stateKeys,
    options.commentAnchors,
  );
  if (!resolution.model)
    return stateNoChange(
      model,
      "invalid",
      resolution.diagnostics[0]
        ? stateSourceDiagnostic(resolution.diagnostics[0])
        : messages.classPatchRejected(),
    );
  const keys = new Set(resolution.document.records.map((r) => r.sourceKey));
  for (const record of model.sourceDocument.records)
    if (!options.removed?.has(record.sourceKey) && !keys.has(record.sourceKey))
      return stateNoChange(model, "invalid", messages.classPatchRejected());
  for (const comment of model.commentRecords) {
    if (
      options.removed?.has(comment.id) ||
      options.commentTransfers?.has(comment.id)
    )
      continue;
    const retained = resolution.model.commentRecords.find(
      (c) => c.id === comment.id,
    );
    if (
      !retained ||
      retained.anchorKind !== comment.anchorKind ||
      retained.anchorId !== comment.anchorId ||
      retained.position !== comment.position
    )
      return stateNoChange(model, "invalid", messages.classPatchRejected());
  }
  for (const [key, expected] of options.commentAnchors ?? []) {
    const actual = resolution.model.commentRecords.find((c) => c.id === key);
    if (
      !actual ||
      actual.anchorKind !== expected.anchorKind ||
      actual.anchorId !== expected.anchorId ||
      actual.position !== expected.position
    )
      return stateNoChange(model, "invalid", messages.classPatchRejected());
  }
  const remap = new Map<string, string>();
  for (const key of keys) remap.set(key, key);
  for (const node of [...model.states, ...model.composites]) {
    const retained = [
      ...resolution.model.states,
      ...resolution.model.composites,
    ].find((n) => n.sourceKey === node.sourceKey);
    if (retained) remap.set(node.sourceKey!, retained.sourceKey!);
  }
  return {
    status: "changed",
    changed: true,
    source: next,
    model: resolution.model,
    patches: sorted,
    reason: "applied",
    selection: options.selection,
    focus: options.focus,
    remap,
    impact: options.impact ?? { records: [] },
  };
}
export function stateRecord(model: MermaidStateModel, key: string) {
  return model.sourceDocument.records.find((r) => r.sourceKey === key);
}
export function stateRecordEnd(record: StateSourceRecord) {
  return record.range.end + record.eol.length;
}
export function stateNewRecordPatch(
  model: MermaidStateModel,
  offset: number,
  text: string,
  key?: string,
): StatePatch {
  const source = model.sourceDocument.source,
    newline = model.sourceDocument.newline;
  const prefix =
    offset > 0 && !/[\r\n]/.test(source[offset - 1]!) ? newline : "";
  const suffix =
    (offset < source.length || /[\r\n]$/.test(source)) && !/[\r\n]$/.test(text)
      ? newline
      : "";
  return {
    range: { start: offset, end: offset },
    value: prefix + text + suffix,
    identities: key ? [[prefix.length, key]] : undefined,
  };
}
export function stateRecordGroup(model: MermaidStateModel, key: string) {
  const record = stateRecord(model, key);
  if (!record) return null;
  const owner = [...model.states, ...model.composites].find(
    (n) =>
      n.recordKeys?.includes(key) || ("closeKey" in n && n.closeKey === key),
  );
  const comments = new Set(
    model.commentRecords
      .filter(
        (c) => c.anchorId === key || (owner && c.anchorId === owner.sourceKey),
      )
      .map((c) => c.id),
  );
  const records = model.sourceDocument.records;
  let first = records.indexOf(record),
    last = first;
  while (
    first > 0 &&
    (records[first - 1]!.kind === "blank" ||
      comments.has(records[first - 1]!.sourceKey))
  )
    first--;
  while (
    last + 1 < records.length &&
    (records[last + 1]!.kind === "blank" ||
      comments.has(records[last + 1]!.sourceKey))
  )
    last++;
  const group = records.slice(first, last + 1);
  return {
    records: group,
    range: { start: group[0]!.range.start, end: stateRecordEnd(group.at(-1)!) },
  };
}
export function stateSpan(model: MermaidStateModel, key: string) {
  const record = stateRecord(model, key);
  if (!record) return null;
  const group = stateRecordGroup(model, key)!;
  const close = record.closeKey ? stateRecord(model, record.closeKey) : null;
  const end = close
    ? stateRecordGroup(model, close.sourceKey)!.range.end
    : group.range.end;
  return {
    range: { start: group.range.start, end },
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= group.range.start && r.range.start < end,
    ),
  };
}
export function stateMoveRecords(
  model: MermaidStateModel,
  records: readonly StateSourceRecord[],
  offset: number,
): StatePatch[] {
  if (!records.length) return [];
  const start = records[0]!.range.start,
    end = stateRecordEnd(records.at(-1)!);
  if (offset >= start && offset <= end) return [];
  let value = model.sourceDocument.source.slice(start, end);
  const patch = stateNewRecordPatch(
    model,
    offset,
    value,
    records[0]!.sourceKey,
  );
  const prefix = patch.identities![0]![0];
  if (offset < model.sourceDocument.source.length && !/[\r\n]$/.test(value))
    value += model.sourceDocument.newline;
  patch.value = patch.value.slice(0, prefix) + value;
  patch.identities = records.map(
    (r) => [prefix + r.range.start - start, r.sourceKey] as const,
  );
  return [{ range: { start, end }, value: "" }, patch];
}
export function stateImpact(
  model: MermaidStateModel,
  records: readonly StateSourceRecord[],
): StateImpact {
  const endpoint = (id: string) => {
    const node = [...model.states, ...model.composites].find(
      (n) => n.id === id,
    );
    return node && "kind" in node && node.kind === "start"
      ? messages.stateStart()
      : node && "kind" in node && node.kind === "end"
        ? messages.stateEnd()
        : (node?.label ?? id);
  };
  return {
    records: records
      .filter((r) => !["blank", "end"].includes(r.kind))
      .map((r) => {
        const transition = model.transitions.find((t) => t.id === r.sourceKey),
          link = model.links.find((l) => l.sourceKey === r.sourceKey),
          style = model.styles.find((s) => s.id === r.sourceKey);
        return {
          id: r.sourceKey,
          kind: r.kind,
          label: stateDisplayText(
            (transition
              ? `${endpoint(transition.from)} → ${endpoint(transition.to)}${transition.label ? ` · ${transition.label}` : ""}`
              : undefined) ??
              (link
                ? `${messages.sequenceOpenLink()} · ${endpoint(link.stateId)} · ${link.url}${link.tooltip ? ` · ${link.tooltip}` : ""}`
                : undefined) ??
              (style
                ? `${style.kind === "assignment" ? messages.treemapClasses() : messages.visualAppearance()} · ${style.owners.map(endpoint).join(", ")} · ${style.kind === "assignment" ? style.styles.join(", ") : style.properties.map((p) => `${p.name}: ${p.value}`).join(", ")}`
                : undefined) ??
              model.notes.find((n) => n.id === r.sourceKey)?.label ??
              model.commentRecords.find((c) => c.id === r.sourceKey)?.text ??
              model.states
                .flatMap((n) => n.descriptions ?? [])
                .find((d) => d.recordKey === r.sourceKey)?.text ??
              (r.ownerId ? endpoint(r.ownerId) : undefined) ??
              r.raw.trim(),
          ),
        };
      }),
  };
}
/** Move a conscious collection of lexical units; foreign interstitial records
 * remain untouched. Each original record start is reserved in the insertion. */
export function stateRelocateRecords(
  model: MermaidStateModel,
  input: readonly StateSourceRecord[],
  offset: number,
  before = "",
  after = "",
  envelopeKeys?: readonly [string, string],
): StatePatch[] | null {
  const records = [...new Set(input)].sort(
    (a, b) => a.range.start - b.range.start,
  );
  const runs: StateSourceRecord[][] = [];
  for (const r of records) {
    const last = runs.at(-1);
    if (last && stateRecordEnd(last.at(-1)!) === r.range.start) last.push(r);
    else runs.push([r]);
  }
  if (
    runs.some(
      (run) =>
        offset > run[0]!.range.start && offset < stateRecordEnd(run.at(-1)!),
    )
  )
    return null;
  let text = before;
  const identities: Array<readonly [number, string]> = [];
  if (envelopeKeys) identities.push([0, envelopeKeys[0]]);
  for (const run of runs) {
    const start = run[0]!.range.start,
      end = stateRecordEnd(run.at(-1)!);
    if (text && !/[\r\n]$/.test(text)) text += model.sourceDocument.newline;
    for (const r of run)
      identities.push([text.length + r.range.start - start, r.sourceKey]);
    text += model.sourceDocument.source.slice(start, end);
  }
  if (after) {
    if (text && !/[\r\n]$/.test(text)) text += model.sourceDocument.newline;
    if (envelopeKeys) identities.push([text.length, envelopeKeys[1]]);
    text += after;
  }
  const insertion = stateNewRecordPatch(model, offset, text, envelopeKeys?.[0]);
  const prefix =
    insertion.identities?.[0]?.[0] ??
    (offset > 0 && !/[\r\n]/.test(model.sourceDocument.source[offset - 1]!)
      ? model.sourceDocument.newline.length
      : 0);
  insertion.identities = identities.map(([at, key]) => [prefix + at, key]);
  return [
    ...runs.map((run) => ({
      range: { start: run[0]!.range.start, end: stateRecordEnd(run.at(-1)!) },
      value: "",
    })),
    insertion,
  ];
}
export function deleteStateRecords(
  model: MermaidStateModel,
  records: readonly StateSourceRecord[],
  options: StateWriteOptions = {},
) {
  const sorted = [...new Set(records)].sort(
      (a, b) => a.range.start - b.range.start,
    ),
    patches: StatePatch[] = [];
  for (const record of sorted) {
    const previous = patches.at(-1),
      end = stateRecordEnd(record);
    if (previous && previous.range.end >= record.range.start)
      previous.range.end = Math.max(previous.range.end, end);
    else patches.push({ range: { start: record.range.start, end }, value: "" });
  }
  return writeStatePatches(model, patches, {
    ...options,
    removed: new Set(sorted.map((r) => r.sourceKey)),
    impact: options.impact ?? stateImpact(model, sorted),
  });
}
export type StateInsertAnchor = {
  parentId?: string | null;
  regionKey?: string | null;
  beforeKey?: string;
  afterKey?: string;
};
/** A scope insertion uses lexical boundaries, never geometric containment. */
export function stateInsertAnchor(
  model: MermaidStateModel,
  anchor: StateInsertAnchor = {},
) {
  const parent = anchor.parentId
    ? model.composites.find((c) => c.id === anchor.parentId)
    : null;
  if (anchor.parentId && !parent) return null;
  const requested =
    anchor.regionKey &&
    model.sourceDocument.records.find(
      (r) =>
        (`${r.sourceKey}:region` === anchor.regionKey &&
          r.kind === "composite") ||
        (r.sourceKey === anchor.regionKey && r.kind === "region"),
    );
  const opener = requested
    ? requested.kind === "composite"
      ? requested
      : stateRecord(model, requested.parentKey!)
    : parent?.recordKeys
        ?.map((k) => stateRecord(model, k))
        .find((r) => r?.kind === "composite");
  if (parent && !opener?.closeKey) return null;
  const primary = opener ? `${opener.sourceKey}:region` : null;
  const regionKey = anchor.regionKey ?? primary;
  const dividers = model.sourceDocument.records.filter(
    (r) => r.parentKey === (opener?.sourceKey ?? null) && r.kind === "region",
  );
  const start =
    regionKey === primary
      ? opener
        ? stateRecordEnd(opener)
        : stateRecordEnd(
            model.sourceDocument.records.find((r) => r.kind === "header")!,
          )
      : dividers.find((r) => r.sourceKey === regionKey)
        ? stateRecordEnd(dividers.find((r) => r.sourceKey === regionKey)!)
        : null;
  if (start === null) return null;
  const nextDivider = dividers.find((r) => r.range.start >= start);
  const close = opener?.closeKey ? stateRecord(model, opener.closeKey) : null;
  const end =
    nextDivider?.range.start ??
    close?.range.start ??
    model.sourceDocument.source.length;
  const record = anchor.beforeKey
    ? stateRecord(model, anchor.beforeKey)
    : anchor.afterKey
      ? stateRecord(model, anchor.afterKey)
      : undefined;
  if (
    (anchor.beforeKey || anchor.afterKey) &&
    (!record ||
      record.parentId !== (anchor.parentId ?? null) ||
      record.regionKey !== regionKey ||
      record.range.start < start ||
      record.range.start >= end)
  )
    return null;
  const group = record
    ? record.kind === "composite"
      ? stateSpan(model, record.sourceKey)
      : stateRecordGroup(model, record.sourceKey)
    : null;
  const offset = record
    ? anchor.beforeKey
      ? Math.max(start, group!.range.start)
      : Math.min(end, group!.range.end)
    : end;
  const indent = record?.indent ?? (opener ? opener.indent + "  " : "  ");
  return {
    offset,
    indent,
    parentId: anchor.parentId ?? null,
    regionKey,
    start,
    end,
  };
}
export function stateTextValue(value: string) {
  return value
    .replaceAll(/\r\n|\r|\n/g, "<br/>")
    .replaceAll(/[#%;:]/g, (c) => `#${c.charCodeAt(0)};`);
}
export function stateSourceIdValue(
  value: string,
  form:
    | "reference"
    | "state"
    | "alias"
    | "composite-alias"
    | "pseudostate"
    | "floating" = "reference",
) {
  return (
    Boolean(value.trim()) &&
    value === value.trim() &&
    !/[\r\n]/.test(value) &&
    !value.includes("%%") &&
    (form === "floating"
      ? true
      : form === "pseudostate"
        ? !/[{]/.test(value) && !/(?:<<|>>|\[\[|\]\])/.test(value)
        : form === "alias"
          ? !/[:{]/.test(value)
          : form === "composite-alias"
            ? !/[{]/.test(value)
            : form === "state"
              ? !/[\s{]/.test(value)
              : !/[\s:\-{]/.test(value)) &&
    value !== "[*]"
  );
}

export function composeStateCommandResults(
  original: MermaidStateModel,
  result: StateCommandResult,
  options: StateWriteOptions = {},
): StateCommandResult {
  if (result.status === "rejected")
    return {
      ...result,
      source: original.sourceDocument.source,
      model: original,
      patches: [],
    };
  const old = original.sourceDocument.records,
    next = result.model.sourceDocument.records;
  const indices = new Map(
    old.map((record, index) => [record.sourceKey, index]),
  );
  const anchors: { old: StateSourceRecord; next: StateSourceRecord }[] = [];
  let last = -1;
  for (const record of next) {
    const index = indices.get(record.sourceKey);
    if (index === undefined || index <= last) continue;
    const previous = old[index]!;
    if (previous.raw !== record.raw || previous.eol !== record.eol) continue;
    anchors.push({ old: previous, next: record });
    last = index;
  }
  const patches: StatePatch[] = [];
  let start = 0,
    nextStart = 0;
  const boundaries = anchors.map((anchor) => ({
    oldStart: anchor.old.range.start,
    oldEnd: stateRecordEnd(anchor.old),
    nextStart: anchor.next.range.start,
    nextEnd: stateRecordEnd(anchor.next),
  }));
  boundaries.push({
    oldStart: original.sourceDocument.source.length,
    oldEnd: original.sourceDocument.source.length,
    nextStart: result.source.length,
    nextEnd: result.source.length,
  });
  for (const anchor of boundaries) {
    const end = anchor.oldStart,
      nextEnd = anchor.nextStart;
    const value = result.source.slice(nextStart, nextEnd);
    if (original.sourceDocument.source.slice(start, end) !== value)
      patches.push({
        range: { start, end },
        value,
        identities: next
          .filter((r) => r.range.start >= nextStart && r.range.start < nextEnd)
          .map((r) => [r.range.start - nextStart, r.sourceKey] as const),
      });
    start = anchor.oldEnd;
    nextStart = anchor.nextEnd;
  }
  const retained = new Set([
    ...next.map((r) => r.sourceKey),
    ...result.model.states.map((n) => n.sourceKey!),
    ...result.model.composites.map((n) => n.sourceKey!),
    ...result.model.states.flatMap((n) =>
      (n.descriptions ?? []).map((d) => d.id),
    ),
  ]);
  return writeStatePatches(original, patches, {
    ...options,
    removed: new Set(
      old.filter((r) => !retained.has(r.sourceKey)).map((r) => r.sourceKey),
    ),
    stateKeys: new Map(
      [...result.model.states, ...result.model.composites].map((n) => [
        n.id,
        n.sourceKey!,
      ]),
    ),
    commentAnchors: new Map(result.model.commentRecords.map((c) => [c.id, c])),
    // Only a deliberately removed owner boundary can transfer a retained comment.
    commentTransfers: new Set([
      ...(options.commentTransfers ?? []),
      ...original.commentRecords
        .filter(
          (comment) =>
            comment.anchorId &&
            !retained.has(comment.anchorId) &&
            retained.has(comment.id),
        )
        .map((comment) => comment.id),
    ]),
    selection: result.selection,
    focus: result.focus,
    impact: result.impact,
  });
}
