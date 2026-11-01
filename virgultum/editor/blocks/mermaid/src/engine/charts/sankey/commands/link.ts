// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyModel } from "../model.js";
import {
  encodeSankeyField,
  sankeyNoChange,
  sankeyPatchedResult,
  type SankeyPatch,
} from "../writer.js";

export type SankeyLinkCommand =
  | {
      readonly type: "link.add";
      readonly source: string;
      readonly target: string;
      readonly value: number;
    }
  | {
      readonly type: "link.endpoint";
      readonly id: string;
      readonly field: "source" | "target";
      readonly value: string;
    }
  | { readonly type: "link.value"; readonly id: string; readonly value: number }
  | {
      readonly type: "link.delete";
      readonly id: string;
      readonly confirmed?: boolean;
    }
  | {
      readonly type: "link.reorder";
      readonly id: string;
      readonly beforeId: string;
      readonly selectionId?: string;
    };

export function sankeyOwnedLinkRange(model: SankeyModel, id: string) {
  const record = model.sourceDocument.records.find(
    (record) => record.id === id && record.kind === "csv",
  );
  if (!record) return null;
  const comments = model.comments.filter((comment) => comment.linkId === id);
  const starts = comments.flatMap((comment) =>
    model.sourceDocument.records
      .filter((record) => record.id === comment.id)
      .map((record) => record.range.start),
  );
  return {
    start: Math.min(record.range.start, ...starts),
    end: record.range.end,
  };
}

export function applySankeyLinkCommand(
  model: SankeyModel,
  command: SankeyLinkCommand,
) {
  if (command.type === "link.add") {
    if (!Number.isFinite(command.value) || command.value < 0)
      return sankeyNoChange(model, "invalid-value");
    const from = encodeSankeyField(command.source);
    const to = encodeSankeyField(command.target);
    if (from === null || to === null)
      return sankeyNoChange(model, "field-syntax");
    const { newline, records } = model.sourceDocument;
    const anchor =
      records.findLast((record) => record.kind === "csv") ??
      records.find((record) => record.kind === "header");
    if (!anchor) return sankeyNoChange(model, "header");
    const result = sankeyPatchedResult(
      model,
      [
        {
          range: { start: anchor.range.end, end: anchor.range.end },
          value: `${newline}${from},${to},${command.value}`,
        },
      ],
      null,
    );
    if (!result.changed) return result;
    const inserted = result.model.links.find(
      (link) => !model.links.some((old) => old.id === link.id),
    );
    return {
      ...result,
      selection: inserted ? { kind: "link" as const, id: inserted.id } : null,
    };
  }
  const record = model.sourceDocument.records.find(
    (record) => record.id === command.id && record.kind === "csv",
  );
  if (!record) return sankeyNoChange(model, "conflict");
  if (command.type === "link.endpoint" || command.type === "link.value") {
    const index =
      command.type === "link.value" ? 2 : command.field === "source" ? 0 : 1;
    const field = record.fields[index];
    if (!field) return sankeyNoChange(model, "field-count");
    if (
      command.type === "link.value" &&
      (!Number.isFinite(command.value) || command.value < 0)
    )
      return sankeyNoChange(model, "invalid-value");
    if (
      field.valid &&
      (command.type === "link.value"
        ? Number.parseFloat(field.value) === command.value
        : field.value === command.value.trim())
    )
      return sankeyNoChange(model, "no-change");
    const value = encodeSankeyField(String(command.value), field);
    if (value === null) return sankeyNoChange(model, "field-syntax");
    return sankeyPatchedResult(model, [{ range: field.range, value }], {
      kind: "link",
      id: command.id,
    });
  }
  const range = sankeyOwnedLinkRange(model, command.id)!;
  if (command.type === "link.delete") {
    if (
      !command.confirmed &&
      model.comments.some((comment) => comment.linkId === command.id)
    )
      return sankeyNoChange(model, "confirmation-required");
    const index = model.links.findIndex((link) => link.id === command.id);
    const next = model.links[index + 1] ?? model.links[index - 1];
    // Leave separation in place: deleting a record must not rebind an adjacent
    // diagram comment to the next record.
    return sankeyPatchedResult(
      model,
      [{ range, value: "" }],
      next ? { kind: "link", id: next.id } : null,
    );
  }
  if (command.id === command.beforeId)
    return sankeyNoChange(model, "no-change");
  const target = sankeyOwnedLinkRange(model, command.beforeId);
  if (!target) return sankeyNoChange(model, "conflict");
  const { source, newline } = model.sourceDocument;
  const text = source.slice(range.start, range.end);
  // The target's bound comments need a blank separator even when the moved
  // record has no comments of its own.
  const inserted = `${newline}${text}${newline}${newline}`;
  const patches: SankeyPatch[] = [
    { range, value: "" },
    { range: { start: target.start, end: target.start }, value: inserted },
  ];
  const destination =
    target.start -
    (range.end <= target.start ? range.end - range.start : 0) +
    newline.length;
  const mapping = new Map<number, string>();
  for (const moved of model.sourceDocument.records.filter(
    (item) => item.range.start >= range.start && item.range.end <= range.end,
  ))
    mapping.set(destination + moved.range.start - range.start, moved.id);
  return sankeyPatchedResult(
    model,
    patches,
    { kind: "link", id: command.selectionId ?? command.id },
    mapping,
  );
}
