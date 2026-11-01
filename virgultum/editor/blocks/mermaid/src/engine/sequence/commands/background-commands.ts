// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidSequenceModel } from "../model.js";
import { nextSequenceSourceKey } from "../source-document.js";
import {
  sequenceRecord,
  sequenceRecordEnd,
  sequenceSpan,
  sequenceAnchor,
  sequenceNewRecordPatch,
  sequenceMoveRecords,
  sequenceTextValue,
  sequenceNoChange,
  writeSequencePatches,
  composeSequenceCommandResults,
  deleteSequenceRecords,
  sequenceImpact,
  type SequencePatch,
  type SequenceTimelineAnchor,
  type SequenceWriteOptions,
  type SequenceCommandResult,
} from "../writer.js";
import { mermaidMessages as m } from "../../../i18n.js";
function backgroundColor(value: string) {
  const hex = /^#([a-f\d]{3}|[a-f\d]{6})$/i.exec(value.trim());
  if (!hex) return /[;#%\r\n]/.test(value) ? null : value.trim();
  const v =
    hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
  return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`;
}
export function addSequenceBox(
  model: MermaidSequenceModel,
  value: { label: string; color: string },
  options: SequenceWriteOptions = {},
) {
  const color = backgroundColor(value.color),
    key = nextSequenceSourceKey(),
    close = nextSequenceSourceKey(),
    header = model.sourceDocument.records.find((r) => r.kind === "header")!;
  if (color === null)
    return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
  const patch = sequenceNewRecordPatch(
    model,
    sequenceRecordEnd(header),
    `  box ${[color, sequenceTextValue(value.label)].filter(Boolean).join(" ")}${model.sourceDocument.newline}  end`,
    key,
  );
  patch.identities = [
    [patch.identities![0]![0], key],
    [patch.value.lastIndexOf("  end"), close],
  ];
  return writeSequencePatches(model, [patch], {
    ...options,
    selection: key,
    focus: key,
  });
}
export function addSequenceRect(
  model: MermaidSequenceModel,
  value: {
    color: string;
    start: SequenceTimelineAnchor;
    end?: SequenceTimelineAnchor;
  },
  options: SequenceWriteOptions = {},
) {
  const color = backgroundColor(value.color),
    start = sequenceAnchor(model, value.start),
    end = value.end ? sequenceAnchor(model, value.end) : start,
    key = nextSequenceSourceKey();
  if (
    !color ||
    !start ||
    !end ||
    start.offset > end.offset ||
    start.parentId !== end.parentId ||
    start.branchId !== end.branchId
  )
    return sequenceNoChange(model, "invalid", m.sequenceScopeConflict());
  return writeSequencePatches(
    model,
    [
      sequenceNewRecordPatch(
        model,
        start.offset,
        `${start.indent}rect ${color}`,
        key,
      ),
      sequenceNewRecordPatch(
        model,
        end.offset,
        `${start.indent}end`,
        nextSequenceSourceKey(),
      ),
    ],
    { ...options, selection: key, focus: key },
  );
}
export function editSequenceBackground(
  model: MermaidSequenceModel,
  key: string,
  changes: {
    color?: string;
    label?: string;
    start?: SequenceTimelineAnchor;
    end?: SequenceTimelineAnchor;
  },
  options: SequenceWriteOptions = {},
): SequenceCommandResult {
  const background = model.backgrounds.find((b) => b.id === key),
    open = sequenceRecord(model, key);
  if (!background || !open)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  if (
    (changes.start || changes.end) &&
    (changes.color !== undefined || changes.label !== undefined)
  ) {
    const first = editSequenceBackground(
      model,
      key,
      { color: changes.color, label: changes.label },
      options,
    );
    if (first.status === "rejected") return first;
    return composeSequenceCommandResults(
      model,
      editSequenceBackground(
        first.model,
        key,
        { start: changes.start, end: changes.end },
        { ...options, baseSource: undefined },
      ),
      options,
    );
  }
  const patches: SequencePatch[] = [];
  if (changes.color !== undefined && changes.color !== background.color) {
    const color = backgroundColor(changes.color);
    if (color === null || (background.kind === "rect" && !color))
      return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
    const end =
      open.range.start +
      open.raw.toLowerCase().indexOf(background.kind) +
      background.kind.length;
    patches.push({
      range: open.values.color ?? { start: end, end },
      value: `${open.values.color ? "" : " "}${color}`,
    });
  }
  if (changes.label !== undefined && changes.label !== background.label) {
    if (background.kind !== "box")
      return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
    const end =
      open.values.color?.end ??
      open.range.start + open.raw.toLowerCase().indexOf("box") + 3;
    patches.push({
      range: open.values.label ?? { start: end, end },
      value: `${open.values.label ? "" : " "}${sequenceTextValue(changes.label)}`,
    });
  }
  if (changes.start || changes.end) {
    if (background.kind !== "rect" || patches.length)
      return sequenceNoChange(model, "invalid", m.sequencePatchRejected());
    const close = sequenceRecord(model, open.closeKey!)!;
    for (const [record, anchor] of [
      [open, changes.start],
      [close, changes.end],
    ] as const)
      if (anchor) {
        const target = sequenceAnchor(model, anchor);
        if (!target)
          return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
        patches.push(...sequenceMoveRecords(model, [record], target.offset));
      }
  }
  return writeSequencePatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
export function deleteSequenceBackground(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
) {
  const span = sequenceSpan(model, key),
    open = sequenceRecord(model, key);
  if (!span || !open)
    return sequenceNoChange(model, "invalid", m.sequenceMissingObject());
  const records = span.records.filter(
    (r) => r.sourceKey === key || r.sourceKey === open.closeKey,
  );
  const transfers = new Set(
    model.commentRecords
      .filter((c) => c.anchorId === key || c.anchorId === open.closeKey)
      .map((c) => c.id),
  );
  return deleteSequenceRecords(model, records, {
    ...options,
    commentTransfers: transfers,
    impact: sequenceImpact(model, span.records),
  });
}
