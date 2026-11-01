// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidGanttSource } from "./parser.js";
import type { GanttRange } from "./source-document.js";
import { ganttAfterLine } from "./source-document.js";
import type {
  GanttSelection,
  MermaidGanttModel,
  MermaidGanttTask,
} from "./types.js";

export type GanttPatch = {
  readonly range: Pick<GanttRange, "start" | "end">;
  readonly value: string;
};

export type GanttCommandResult = {
  readonly changed: boolean;
  readonly diagnosis: string;
  readonly model: MermaidGanttModel;
  /** A rejected candidate is preview-only; model/source remain uncommitted. */
  readonly rejectedModel?: MermaidGanttModel;
  readonly source: string;
  readonly selection: GanttSelection;
};

export function ganttNoChange(
  model: MermaidGanttModel,
  diagnosis: string,
): GanttCommandResult {
  return {
    changed: false,
    diagnosis,
    model,
    selection: null,
    source: model.sourceDocument.source,
  };
}

/**
 * Applies disjoint patches from the end of the source backwards so earlier
 * ranges stay valid. Overlapping or out-of-order ranges are rejected instead
 * of producing a corrupted document.
 */
export function applyGanttPatches(
  source: string,
  patches: readonly GanttPatch[],
) {
  const ordered = [...patches].sort((a, b) => b.range.start - a.range.start);
  let result = source;
  let boundary = source.length;
  for (const patch of ordered) {
    if (
      patch.range.start < 0 ||
      patch.range.end < patch.range.start ||
      patch.range.end > boundary
    ) {
      return null;
    }
    result =
      result.slice(0, patch.range.start) +
      patch.value +
      result.slice(patch.range.end);
    boundary = patch.range.start;
  }
  return result;
}

export function ganttPatchedOffset(
  position: number,
  patches: readonly GanttPatch[],
) {
  return patches.reduce(
    (offset, patch) =>
      patch.range.end <= position
        ? offset + patch.value.length - (patch.range.end - patch.range.start)
        : offset,
    position,
  );
}

function sameDiagnostic(
  left: MermaidGanttModel["diagnostics"][number],
  right: MermaidGanttModel["diagnostics"][number],
) {
  return (
    left.code === right.code &&
    left.statementId === right.statementId &&
    left.field === right.field
  );
}

/**
 * Reparses the patched source before commit and rejects only defects the
 * patch itself introduced. Pre-existing local diagnoses stay untouched so a
 * partially invalid diagram remains editable elsewhere.
 */
export function ganttPatchedResult(
  model: MermaidGanttModel,
  patches: readonly GanttPatch[],
  selection: GanttSelection,
  relocated?: ReadonlyMap<number, string>,
): GanttCommandResult {
  if (model.ambiguous) return ganttNoChange(model, "ambiguous-source");
  const source = applyGanttPatches(model.sourceDocument.source, patches);
  if (source === null) return ganttNoChange(model, "conflict");
  if (source === model.sourceDocument.source)
    return ganttNoChange(model, "no-change");
  const mapping = new Map<number, string>();
  for (const statement of model.sourceDocument.statements) {
    const covering = patches.find(
      (patch) =>
        patch.range.start <= statement.range.start &&
        patch.range.end >= statement.range.end,
    );
    if (covering) {
      // A whole-statement replacement retains its semantic record even when
      // earlier removals shift it. Range/raw fallback must not assign a deleted
      // predecessor's identity to a rewritten dependent.
      if (
        covering.range.start === statement.range.start &&
        covering.range.end === statement.range.end &&
        covering.value.trim()
      )
        mapping.set(
          ganttPatchedOffset(statement.range.start, patches),
          statement.id,
        );
      continue;
    }
    mapping.set(
      ganttPatchedOffset(statement.range.start, patches),
      statement.id,
    );
  }
  for (const [offset, id] of relocated ?? []) mapping.set(offset, id);
  const next = parseMermaidGanttSource(source, model, mapping);
  if (!next || next.ambiguous) return ganttNoChange(model, "ambiguous-source");
  const introduced = next.diagnostics.find(
    (diagnostic) =>
      diagnostic.code !== "conflict" &&
      !model.diagnostics.some((old) => sameDiagnostic(old, diagnostic)),
  );
  if (introduced)
    return { ...ganttNoChange(model, introduced.code), rejectedModel: next };
  if (
    next.tasks.some(
      (task) =>
        model.intervals[task.recordId] && !next.intervals[task.recordId],
    )
  )
    return {
      ...ganttNoChange(model, "unresolved-schedule"),
      rejectedModel: next,
    };
  return { changed: true, diagnosis: "ok", model: next, selection, source };
}

/** Inserts a full statement line after the given statement, keeping EOL+indent. */
export function ganttInsertAfter(
  model: MermaidGanttModel,
  statementId: string | null,
  line: string,
  indent = "  ",
): GanttPatch | null {
  const document = model.sourceDocument;
  const newline = document.newline;
  if (!statementId) {
    const header = document.statements.find(
      (statement) => statement.kind === "header",
    );
    if (!header) return null;
    return ganttInsertAfter(model, header.id, line, indent);
  }
  const statement = document.statements.find(
    (candidate) => candidate.id === statementId,
  );
  if (!statement) return null;
  const at = ganttAfterLine(document.source, statement.range.end);
  // A document whose last statement has no line ending must still receive a
  // separate line, otherwise the new statement fuses into the previous one.
  const needsLeadingBreak =
    at === document.source.length && !document.source.endsWith(newline);
  return {
    range: { end: at, start: at },
    value: `${needsLeadingBreak ? newline : ""}${indent}${line}${newline}`,
  };
}

/** Replaces one statement's raw text while preserving its line ending. */
export function ganttReplaceStatement(
  model: MermaidGanttModel,
  statementId: string,
  raw: string,
): GanttPatch | null {
  const statement = model.sourceDocument.statements.find(
    (candidate) => candidate.id === statementId,
  );
  if (!statement) return null;
  return {
    range: { end: statement.range.end, start: statement.range.start },
    value: raw,
  };
}

/** Deletes a statement including its line ending. */
export function ganttDeleteStatement(
  model: MermaidGanttModel,
  statementId: string,
): GanttPatch | null {
  const document = model.sourceDocument;
  const statement = document.statements.find(
    (candidate) => candidate.id === statementId,
  );
  if (!statement) return null;
  return {
    range: {
      end: ganttAfterLine(document.source, statement.range.end),
      start: statement.range.start,
    },
    value: "",
  };
}

/** Serializes a task data list in the model's current local convention. */
export function encodeGanttTaskData(task: MermaidGanttTask) {
  const parts: string[] = [...task.statuses];
  if (task.isMilestone) parts.push("milestone");
  if (task.isVert) parts.push("vert");
  if (task.explicitId) parts.push(task.id);
  // `after` and `until` are independent fields of one task statement; a task
  // may legitimately couple an `after` start with an `until` end. Emitting the
  // start clause must never drop a coexisting `until` reference.
  if (task.scheduleKind === "after")
    parts.push(`after ${task.afterIds.join(" ")}`);
  else if (task.scheduleKind === "explicit" || task.scheduleKind === "until")
    parts.push(task.start);
  // An `until` end is independent of the start form, so emit it before the
  // ordinary end/duration clause; an `after` task still keeps its length.
  if (task.untilIds.length) parts.push(`until ${task.untilIds.join(" ")}`);
  else if (task.end) parts.push(task.end);
  else if (task.duration) parts.push(task.duration);
  return parts.join(", ");
}

export function encodeGanttTaskLine(task: MermaidGanttTask, indent = "  ") {
  return `${indent}${task.label} : ${encodeGanttTaskData(task)}`;
}

export type GanttSourceSpan = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

/** Byte span covering the given statements including their line endings. */
export function ganttStatementSpan(
  model: MermaidGanttModel,
  statementIds: readonly string[],
): GanttSourceSpan | null {
  const document = model.sourceDocument;
  const statements = statementIds
    .map((id) => document.statements.find((candidate) => candidate.id === id))
    .filter((statement): statement is NonNullable<typeof statement> =>
      Boolean(statement),
    );
  if (!statements.length) return null;
  const start = Math.min(...statements.map((s) => s.range.start));
  const end = Math.max(
    ...statements.map((s) => ganttAfterLine(document.source, s.range.end)),
  );
  return { end, start, text: document.source.slice(start, end) };
}

/**
 * Moves a byte span to another offset with exactly two disjoint patches, so
 * every byte inside the moved block (labels, trivia, bound comments) survives
 * untouched and unrelated source stays stable.
 */
export function ganttMovePatches(
  model: MermaidGanttModel,
  span: GanttSourceSpan,
  anchorOffset: number,
): readonly GanttPatch[] | null {
  if (anchorOffset === span.start || anchorOffset === span.end) return [];
  if (anchorOffset > span.start && anchorOffset < span.end) return null;
  const { newline, source } = model.sourceDocument;
  // The anchor is a statement end + its line ending; a source whose last
  // statement has no trailing line ending puts the anchor mid-line, so a
  // block moved there must open its own line instead of fusing into it.
  const atLineStart =
    anchorOffset === 0 ||
    source[anchorOffset - 1] === "\n" ||
    source[anchorOffset - 1] === "\r";
  // A leading object-comment block needs separation from its new predecessor
  // as well as adjacency to its object, otherwise parsing changes its owner.
  const startsWithComment = model.sourceDocument.statements.some(
    (statement) =>
      statement.range.start === span.start && statement.kind === "comment",
  );
  let insertValue =
    !startsWithComment &&
    (atLineStart || span.text.startsWith("\n") || span.text.startsWith("\r"))
      ? span.text
      : `${newline}${span.text}`;
  // An EOF record has no terminating EOL. Moving it before retained source
  // must close its line too, not fuse it with the following statement.
  if (anchorOffset < source.length && !/[\r\n]$/.test(insertValue))
    insertValue += newline;
  return [
    { range: { end: span.end, start: span.start }, value: "" },
    { range: { end: anchorOffset, start: anchorOffset }, value: insertValue },
  ];
}

/** Offset just after a statement's line ending, used as a move anchor. */
export function ganttAnchorAfter(
  model: MermaidGanttModel,
  statementId: string | null,
): number | null {
  const document = model.sourceDocument;
  if (!statementId) {
    const header = document.statements.find((s) => s.kind === "header");
    return header ? ganttAfterLine(document.source, header.range.end) : null;
  }
  const statement = document.statements.find((s) => s.id === statementId);
  return statement
    ? ganttAfterLine(document.source, statement.range.end)
    : null;
}

/**
 * Appends a diagram-level statement after the last existing line. Diagram
 * comments belong to the whole source, so they must not land between the header
 * and the first statement.
 */
export function ganttAppendAtEnd(
  model: MermaidGanttModel,
  line: string,
  indent = "  ",
): GanttPatch {
  const document = model.sourceDocument;
  const source = document.source;
  const newline = document.newline;
  const needsBreak = source.length > 0 && !source.endsWith(newline);
  return {
    range: { end: source.length, start: source.length },
    value: `${needsBreak ? newline : ""}${/^[ \t]/.test(line) ? line : `${indent}${line}`}${newline}`,
  };
}
