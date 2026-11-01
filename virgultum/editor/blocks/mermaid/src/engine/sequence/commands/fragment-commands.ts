// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidSequenceModel,
  MermaidSequenceControlKind,
  MermaidSequenceControlBranchKind,
} from "../model.js";
import { nextSequenceSourceKey } from "../source-document.js";
import {
  sequenceAnchor,
  sequenceRecord,
  sequenceRecordEnd,
  sequenceSpan,
  sequenceNewRecordPatch,
  sequenceMoveRecords,
  sequenceTextValue,
  sequenceNoChange,
  writeSequencePatches,
  deleteSequenceRecords,
  reorderSequenceSpan,
  sequenceImpact,
  type SequencePatch,
  type SequenceWriteOptions,
  type SequenceTimelineAnchor,
} from "../writer.js";
import { mermaidMessages as m } from "../../../i18n.js";
export const SEQUENCE_FRAGMENT_KINDS = [
  "loop",
  "alt",
  "opt",
  "par",
  "par_over",
  "critical",
  "break",
] as const;
export function sequenceBranchKind(
  kind: MermaidSequenceControlKind,
): Exclude<MermaidSequenceControlBranchKind, "primary"> | null {
  return kind === "alt"
    ? "else"
    : kind === "par" || kind === "par_over"
      ? "and"
      : kind === "critical"
        ? "option"
        : null;
}
export function addSequenceFragment(
  model: MermaidSequenceModel,
  value: {
    kind: MermaidSequenceControlKind;
    label: string;
    start: SequenceTimelineAnchor;
    end?: SequenceTimelineAnchor;
  },
  options: SequenceWriteOptions = {},
) {
  const start = sequenceAnchor(model, value.start),
    end = value.end ? sequenceAnchor(model, value.end) : start,
    key = nextSequenceSourceKey(),
    closeKey = nextSequenceSourceKey();
  if (
    !start ||
    !end ||
    !SEQUENCE_FRAGMENT_KINDS.includes(value.kind) ||
    start.offset > end.offset ||
    start.parentId !== end.parentId ||
    start.branchId !== end.branchId
  )
    return sequenceNoChange(model, "invalid", m.sequenceScopeConflict());
  const open = sequenceNewRecordPatch(
    model,
    start.offset,
    `${start.indent}${value.kind}${value.label ? ` ${sequenceTextValue(value.label)}` : ""}`,
    key,
  );
  const close = sequenceNewRecordPatch(
    model,
    end.offset,
    `${start.indent}end`,
    closeKey,
  );
  return writeSequencePatches(model, [open, close], {
    ...options,
    selection: key,
    focus: key,
    impact: sequenceImpact(
      model,
      model.sourceDocument.records.filter(
        (r) => r.range.start >= start.offset && r.range.start < end.offset,
      ),
    ),
  });
}
export function editSequenceFragment(
  model: MermaidSequenceModel,
  key: string,
  value: { kind?: MermaidSequenceControlKind; label?: string },
  options: SequenceWriteOptions = {},
) {
  const fragment = model.controls.find((c) => c.id === key),
    record = sequenceRecord(model, key);
  if (!fragment || !record)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const patches: SequencePatch[] = [];
  if (value.kind && value.kind !== fragment.kind) {
    if (
      !SEQUENCE_FRAGMENT_KINDS.includes(value.kind) ||
      fragment.branches
        .slice(1)
        .some((b) => b.kind !== sequenceBranchKind(value.kind!))
    )
      return sequenceNoChange(model, "invalid", m.sequenceInvalidBranch());
    patches.push({ range: record.values.kind!, value: value.kind });
  }
  if (value.label !== undefined && value.label !== fragment.label) {
    const end =
      record.range.end -
      (/;\s*$/.test(record.raw)
        ? record.raw.length - record.raw.lastIndexOf(";")
        : 0);
    patches.push({
      range: record.values.label ?? { start: end, end },
      value: `${record.values.label ? "" : " "}${sequenceTextValue(value.label)}`,
    });
  }
  return writeSequencePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
export const reorderSequenceFragment = reorderSequenceSpan;
export function nestSequenceFragment(
  model: MermaidSequenceModel,
  key: string,
  parentId: string | null,
  branchId?: string,
  options: SequenceWriteOptions = {},
) {
  const fragment = model.controls.find((c) => c.id === key),
    parent = parentId
      ? model.controls.find((c) => c.id === parentId)
      : undefined,
    span = sequenceSpan(model, key);
  if (!fragment || !span || (parentId && !parent) || parentId === key)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const branch =
    parent?.branches.find((b) => b.id === branchId) ?? parent?.branches[0];
  const next =
    branch && parent
      ? parent.branches[parent.branches.indexOf(branch) + 1]
      : undefined;
  const target = parent
    ? sequenceRecord(
        model,
        next?.id ?? sequenceRecord(model, parent.id)!.closeKey!,
      )!
    : undefined;
  const offset = target?.range.start ?? model.sourceDocument.source.length;
  if (offset >= span.range.start && offset <= span.range.end)
    return sequenceNoChange(model, "invalid", m.sequenceScopeConflict());
  return writeSequencePatches(
    model,
    sequenceMoveRecords(model, span.records, offset),
    {
      ...options,
      selection: key,
      focus: key,
      impact: sequenceImpact(model, span.records),
    },
  );
}
export function deleteSequenceFragment(
  model: MermaidSequenceModel,
  key: string,
  keepContents: boolean,
  options: SequenceWriteOptions = {},
) {
  const span = sequenceSpan(model, key),
    record = sequenceRecord(model, key);
  if (!span || !record)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const boundaries = new Set([
    key,
    record.closeKey,
    ...model.controls
      .find((c) => c.id === key)!
      .branches.slice(1)
      .map((b) => b.id),
  ]);
  const records = keepContents
    ? span.records.filter((r) => boundaries.has(r.sourceKey))
    : span.records;
  return deleteSequenceRecords(model, records, {
    ...options,
    commentTransfers: keepContents
      ? new Set(
          model.commentRecords
            .filter(
              (c) =>
                c.anchorId &&
                (boundaries.has(c.anchorId) ||
                  c.anchorId ===
                    model.controls.find((c) => c.id === key)!.branches[0]!.id),
            )
            .map((c) => c.id),
        )
      : undefined,
    impact: sequenceImpact(model, records),
  });
}
export function sequenceBranchSpan(model: MermaidSequenceModel, key: string) {
  const fragment = model.controls.find((c) =>
      c.branches.some((b) => b.id === key),
    ),
    branch = fragment?.branches.find((b) => b.id === key);
  if (!fragment || !branch) return null;
  const index = fragment.branches.indexOf(branch),
    open = sequenceRecord(model, index === 0 ? fragment.id : branch.id)!,
    next = sequenceRecord(
      model,
      fragment.branches[index + 1]?.id ??
        open.closeKey ??
        sequenceRecord(model, fragment.id)!.closeKey!,
    )!;
  const headerComment =
    index === 0
      ? model.sourceDocument.records.find(
          (r) =>
            r.kind === "comment" &&
            r.range.line === open.range.line &&
            model.commentRecords.some(
              (c) =>
                c.id === r.sourceKey &&
                c.anchorKind === "fragment" &&
                c.anchorId === fragment.id,
            ),
        )
      : undefined;
  const start =
      index === 0 ? sequenceRecordEnd(headerComment ?? open) : open.range.start,
    end = next.range.start;
  return {
    fragment,
    branch,
    open,
    range: { start, end },
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= start && r.range.start < end,
    ),
  };
}
export function addSequenceBranch(
  model: MermaidSequenceModel,
  fragmentId: string,
  value: { label: string; beforeId?: string },
  options: SequenceWriteOptions = {},
) {
  const fragment = model.controls.find((c) => c.id === fragmentId),
    kind = fragment ? sequenceBranchKind(fragment.kind) : null;
  if (!fragment || !kind)
    return sequenceNoChange(model, "invalid", m.sequenceInvalidBranch());
  const at = value.beforeId
    ? fragment.branches.find(
        (b) => b.id === value.beforeId && b.kind !== "primary",
      )
    : undefined;
  if (value.beforeId && !at)
    return sequenceNoChange(model, "invalid", m.sequenceInvalidBranch());
  const record = sequenceRecord(
      model,
      at?.id ?? sequenceRecord(model, fragmentId)!.closeKey!,
    )!,
    key = nextSequenceSourceKey();
  return writeSequencePatches(
    model,
    [
      sequenceNewRecordPatch(
        model,
        record.range.start,
        `${record.indent}${kind}${value.label ? ` ${sequenceTextValue(value.label)}` : ""}`,
        key,
      ),
    ],
    { ...options, selection: key, focus: key },
  );
}
export function editSequenceBranch(
  model: MermaidSequenceModel,
  key: string,
  value: { label?: string; kind?: MermaidSequenceControlBranchKind },
  options: SequenceWriteOptions = {},
) {
  const span = sequenceBranchSpan(model, key);
  if (!span)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (value.kind && value.kind !== span.branch.kind)
    return sequenceNoChange(model, "invalid", m.sequenceInvalidBranch());
  if (span.branch.kind === "primary")
    return editSequenceFragment(
      model,
      span.fragment.id,
      { label: value.label },
      options,
    );
  if (value.label === undefined || value.label === span.branch.label)
    return sequenceNoChange(model);
  const end =
    span.open.range.end -
    (/;\s*$/.test(span.open.raw)
      ? span.open.raw.length - span.open.raw.lastIndexOf(";")
      : 0);
  return writeSequencePatches(
    model,
    [
      {
        range: span.open.values.label ?? { start: end, end },
        value: `${span.open.values.label ? "" : " "}${sequenceTextValue(value.label)}`,
      },
    ],
    { ...options, selection: key, focus: key },
  );
}
export function deleteSequenceBranch(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
) {
  const span = sequenceBranchSpan(model, key);
  return span
    ? deleteSequenceRecords(model, span.records, {
        ...options,
        impact: sequenceImpact(model, span.records),
      })
    : sequenceNoChange(model, "invalid", m.sequenceMissingObject());
}
export function reorderSequenceBranch(
  model: MermaidSequenceModel,
  key: string,
  beforeId?: string,
  options: SequenceWriteOptions = {},
) {
  const span = sequenceBranchSpan(model, key),
    before = beforeId ? sequenceBranchSpan(model, beforeId) : undefined;
  if (
    !span ||
    (beforeId && !before) ||
    (before && before.fragment.id !== span.fragment.id)
  )
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (key === beforeId) return sequenceNoChange(model);
  if (span.branch.kind === "primary" || before?.branch.kind === "primary") {
    const ordered = span.fragment.branches.filter((b) => b.id !== key);
    const at = beforeId
      ? ordered.findIndex((b) => b.id === beforeId)
      : ordered.length;
    ordered.splice(at, 0, span.branch);
    const primary = ordered[0]!,
      open = sequenceRecord(model, span.fragment.id)!,
      close = sequenceRecord(model, open.closeKey!)!;
    const requiredKind = sequenceBranchKind(span.fragment.kind);
    if (!requiredKind)
      return sequenceNoChange(model, "invalid", m.sequenceInvalidBranch());
    const labelRange = open.values.label;
    const nextLabelRange =
      primary.kind === "primary"
        ? open.values.label
        : sequenceRecord(model, primary.id)!.values.label;
    const label = nextLabelRange
      ? model.sourceDocument.source.slice(
          nextLabelRange.start,
          nextLabelRange.end,
        )
      : "";
    const end = open.raw.replace(/;\s*$/, "").length;
    let value = labelRange
      ? open.raw.slice(0, labelRange.start - open.range.start) +
        label +
        open.raw.slice(labelRange.end - open.range.start)
      : open.raw.slice(0, end) +
        (label ? ` ${label}` : "") +
        open.raw.slice(end);
    value += open.eol;
    const identities: Array<readonly [number, string]> = [[0, open.sourceKey]];
    const oldBodyStart = sequenceBranchSpan(
      model,
      span.fragment.branches[0]!.id,
    )!.range.start;
    const prefixStart = sequenceRecordEnd(open);
    for (const r of model.sourceDocument.records.filter(
      (r) => r.range.start >= prefixStart && r.range.start < oldBodyStart,
    ))
      identities.push([
        value.length + r.range.start - prefixStart,
        r.sourceKey,
      ]);
    value += model.sourceDocument.source.slice(prefixStart, oldBodyStart);
    if (!/[\r\n]$/.test(value)) value += model.sourceDocument.newline;
    for (const [i, branch] of ordered.entries()) {
      const body = sequenceBranchSpan(model, branch.id)!;
      if (i > 0) {
        if (branch.kind === "primary") {
          identities.push([value.length, branch.id]);
          value += `${open.indent}${requiredKind}${branch.label ? ` ${sequenceTextValue(branch.label)}` : ""}${model.sourceDocument.newline}`;
        } else {
          identities.push([value.length, body.open.sourceKey]);
          value += body.open.raw + body.open.eol;
        }
      }
      const start =
        branch.kind === "primary"
          ? body.range.start
          : sequenceRecordEnd(body.open);
      for (const r of body.records.filter((r) => r.range.start >= start))
        identities.push([value.length + r.range.start - start, r.sourceKey]);
      value += model.sourceDocument.source.slice(start, body.range.end);
      if (!/[\r\n]$/.test(value)) value += model.sourceDocument.newline;
    }
    return writeSequencePatches(
      model,
      [
        {
          range: { start: open.range.start, end: close.range.start },
          value,
          identities,
        },
      ],
      {
        ...options,
        removed: new Set([primary.id]),
        primaryBranchKeys: new Map([[span.fragment.id, primary.id]]),
        selection: key,
        focus: key,
        impact: sequenceImpact(
          model,
          sequenceSpan(model, span.fragment.id)!.records,
        ),
      },
    );
  }
  const offset =
    before?.range.start ??
    sequenceRecord(model, sequenceRecord(model, span.fragment.id)!.closeKey!)!
      .range.start;
  return writeSequencePatches(
    model,
    sequenceMoveRecords(model, span.records, offset),
    {
      ...options,
      selection: key,
      focus: key,
      impact: sequenceImpact(model, span.records),
    },
  );
}
