// SPDX-License-Identifier: AGPL-3.0-or-later

import { hasBlockingMermaidPieDiagnostic } from "./diagnostics.js";
import {
  type MermaidPieComment,
  type MermaidPieLegendPosition,
  type MermaidPieModel,
  type MermaidPieOptions,
} from "./model.js";
import {
  mermaidPieFingerprint,
  mermaidPieRecordId,
} from "./source-document.js";

export type MermaidPieCommandSelection =
  | { readonly kind: "diagram" }
  | { readonly id: string; readonly kind: "comment" | "slice" };

export type MermaidPieCommandDiagnosis = {
  readonly code: string;
  readonly recordId?: string;
};

export type MermaidPieCommand =
  | {
      readonly afterSliceId?: string;
      readonly label: string;
      readonly type: "slice.add";
      readonly value: number;
    }
  | {
      readonly label: string;
      readonly sliceId: string;
      readonly type: "slice.rename";
    }
  | {
      readonly sliceId: string;
      readonly type: "slice.value";
      readonly value: number;
    }
  | {
      readonly beforeSliceId?: string;
      readonly sliceId: string;
      readonly type: "slice.reorder";
    }
  | { readonly sliceId: string; readonly type: "slice.delete" }
  | { readonly title: string; readonly type: "diagram.title" }
  | {
      readonly options: MermaidPieOptions;
      readonly showData: boolean;
      readonly type: "diagram.appearance";
    }
  | { readonly showData: boolean; readonly type: "diagram.show-data" }
  | {
      readonly field: keyof MermaidPieOptions;
      readonly type: "diagram.option";
      readonly value: MermaidPieOptions[keyof MermaidPieOptions];
    }
  | {
      readonly field: "accessibilityDescription" | "accessibilityTitle";
      readonly type: "diagram.accessibility";
      readonly value: string;
    }
  | {
      readonly description: string;
      readonly title: string;
      readonly type: "diagram.accessibility-settings";
    }
  | {
      readonly anchor:
        | { readonly kind: "diagram" }
        | { readonly kind: "slice"; readonly sliceId: string };
      readonly position: MermaidPieComment["position"];
      readonly text: string;
      readonly type: "comment.add";
    }
  | {
      readonly commentId: string;
      readonly text: string;
      readonly type: "comment.update";
    }
  | { readonly commentId: string; readonly type: "comment.delete" };

export type MermaidPieCommandResult = {
  readonly changed: boolean;
  readonly command: MermaidPieCommand;
  readonly diagnosis: MermaidPieCommandDiagnosis;
  readonly model: MermaidPieModel;
  readonly selectionAfter: MermaidPieCommandSelection;
};

function clonePieModel(model: MermaidPieModel) {
  return structuredClone(model);
}

function unchangedPieCommand(
  model: MermaidPieModel,
  command: MermaidPieCommand,
  selectionAfter: MermaidPieCommandSelection,
  code: string,
  recordId?: string,
): MermaidPieCommandResult {
  return {
    changed: false,
    command,
    diagnosis: { code, recordId },
    model,
    selectionAfter,
  };
}

function changedPieCommand(
  model: MermaidPieModel,
  command: MermaidPieCommand,
  selectionAfter: MermaidPieCommandSelection,
): MermaidPieCommandResult {
  return {
    changed: true,
    command,
    diagnosis: { code: "pie.ok" },
    model,
    selectionAfter,
  };
}

function sliceSelection(sliceId: string): MermaidPieCommandSelection {
  return { id: sliceId, kind: "slice" };
}

function pieSliceRecord(model: MermaidPieModel, sliceId: string) {
  const slice = model.slices.find((candidate) => candidate.id === sliceId);
  const record = slice?.sourceRecordId
    ? model.sourceDocument.records.find(
        (candidate) =>
          candidate.kind === "slice" && candidate.id === slice.sourceRecordId,
      )
    : undefined;
  return { record, slice };
}

function protectedSliceDiagnosis(model: MermaidPieModel, sliceId: string) {
  const { record, slice } = pieSliceRecord(model, sliceId);
  if (!slice) return { code: "pie.slice-not-found" };
  if (record && hasBlockingMermaidPieDiagnostic(model.diagnostics, record.id)) {
    return { code: "pie.slice-source-invalid", recordId: record.id };
  }
  return null;
}

function normalizedCommentText(value: string) {
  return value.trim().replace(/^%%\s*/, "");
}

function normalizedSingleLine(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function nextMermaidPieSliceLabel(
  model: MermaidPieModel,
  preferred: string,
) {
  const base = normalizedSingleLine(preferred);
  let candidate = base;
  let suffix = 2;
  while (
    model.slices.some((slice) => slice.label === candidate) ||
    model.conflicts.some((conflict) => conflict.label === candidate)
  ) {
    candidate = `${base} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function diagnoseMermaidPieSliceDraft(
  model: MermaidPieModel,
  label: string,
  value: number,
) {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) return "pie.slice-label-empty";
  if (
    model.slices.some((slice) => slice.label === normalizedLabel) ||
    model.conflicts.some((conflict) => conflict.label === normalizedLabel)
  ) {
    return "pie.slice-label-duplicate";
  }
  if (!Number.isFinite(value) || value < 0) return "pie.slice-value-invalid";
  return null;
}

function nextDraftId(
  model: MermaidPieModel,
  kind: "comment" | "slice",
  key: string,
) {
  const occupied = new Set(
    kind === "slice"
      ? [
          ...model.slices.map((slice) => slice.id),
          ...model.conflicts.map((conflict) => conflict.sliceId),
        ]
      : model.comments.map((comment) => comment.id),
  );
  const fingerprint = mermaidPieFingerprint(`${model.sourceHash}\n${key}`);
  let occurrence = 0;
  let id = mermaidPieRecordId(`${kind}-draft`, fingerprint, occurrence);
  while (occupied.has(id)) {
    occurrence += 1;
    id = mermaidPieRecordId(`${kind}-draft`, fingerprint, occurrence);
  }
  return id;
}

function validOption(
  model: MermaidPieModel,
  field: keyof MermaidPieOptions,
  value: MermaidPieOptions[keyof MermaidPieOptions],
) {
  if (field === "textPosition") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    );
  }
  if (field === "donutHole") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 0.9
    );
  }
  if (field === "legendPosition") {
    return (["bottom", "center", "left", "right", "top"] as const).includes(
      value as MermaidPieLegendPosition,
    );
  }
  return (
    typeof value === "string" &&
    (value === "" ||
      value === "hover" ||
      model.slices.some((slice) => slice.label === value))
  );
}

export function applyMermaidPieCommand(
  model: MermaidPieModel,
  command: MermaidPieCommand,
): MermaidPieCommandResult {
  if (command.type === "slice.add") {
    const label = command.label.trim();
    const selectionAfter: MermaidPieCommandSelection = { kind: "diagram" };
    const draftDiagnosis = diagnoseMermaidPieSliceDraft(
      model,
      label,
      command.value,
    );
    if (draftDiagnosis) {
      return unchangedPieCommand(
        model,
        command,
        selectionAfter,
        draftDiagnosis,
      );
    }
    if (
      command.afterSliceId &&
      !model.slices.some((slice) => slice.id === command.afterSliceId)
    ) {
      return unchangedPieCommand(
        model,
        command,
        selectionAfter,
        "pie.slice-anchor-not-found",
      );
    }
    const next = clonePieModel(model);
    const id = nextDraftId(next, "slice", `${label}\n${command.value}`);
    const insertionIndex = command.afterSliceId
      ? next.slices.findIndex((slice) => slice.id === command.afterSliceId) + 1
      : next.slices.length;
    next.slices.splice(insertionIndex, 0, {
      id,
      label,
      order: insertionIndex,
      value: command.value,
    });
    next.slices.forEach((slice, order) => {
      slice.order = order;
    });
    return changedPieCommand(next, command, sliceSelection(id));
  }

  if (
    command.type === "slice.rename" ||
    command.type === "slice.value" ||
    command.type === "slice.reorder" ||
    command.type === "slice.delete"
  ) {
    const selectionAfter = sliceSelection(command.sliceId);
    const protectedDiagnosis = protectedSliceDiagnosis(model, command.sliceId);
    if (protectedDiagnosis) {
      return unchangedPieCommand(
        model,
        command,
        selectionAfter,
        protectedDiagnosis.code,
        protectedDiagnosis.recordId,
      );
    }
    const next = clonePieModel(model);
    const index = next.slices.findIndex(
      (slice) => slice.id === command.sliceId,
    );
    const slice = next.slices[index];
    if (command.type === "slice.rename") {
      const label = command.label.trim();
      if (!label) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.slice-label-empty",
        );
      }
      if (
        next.slices.some(
          (candidate) => candidate.id !== slice.id && candidate.label === label,
        ) ||
        next.conflicts.some((conflict) => conflict.label === label)
      ) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.slice-label-duplicate",
        );
      }
      if (slice.label === label) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.no-change",
        );
      }
      slice.label = label;
      return changedPieCommand(next, command, selectionAfter);
    }
    if (command.type === "slice.value") {
      if (!Number.isFinite(command.value) || command.value < 0) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.slice-value-invalid",
        );
      }
      if (slice.value === command.value) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.no-change",
        );
      }
      slice.value = command.value;
      return changedPieCommand(next, command, selectionAfter);
    }
    if (command.type === "slice.reorder") {
      if (command.beforeSliceId === command.sliceId) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.no-change",
        );
      }
      const without = next.slices.filter(
        (candidate) => candidate.id !== command.sliceId,
      );
      const targetIndex = command.beforeSliceId
        ? without.findIndex(
            (candidate) => candidate.id === command.beforeSliceId,
          )
        : without.length;
      if (targetIndex < 0) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.slice-anchor-not-found",
        );
      }
      without.splice(targetIndex, 0, slice);
      if (
        without.every(
          (candidate, order) => candidate.id === model.slices[order]?.id,
        )
      ) {
        return unchangedPieCommand(
          model,
          command,
          selectionAfter,
          "pie.no-change",
        );
      }
      next.slices = without;
      next.slices.forEach((candidate, order) => {
        candidate.order = order;
      });
      return changedPieCommand(next, command, selectionAfter);
    }
    const remaining = next.slices.filter(
      (candidate) => candidate.id !== command.sliceId,
    );
    const fallback = remaining[Math.min(index, remaining.length - 1)];
    const commentFallback = remaining[index];
    next.slices = remaining;
    next.slices.forEach((candidate, order) => {
      candidate.order = order;
    });
    for (const comment of next.comments) {
      if (
        comment.anchorKind !== "slice" ||
        comment.anchorId !== command.sliceId
      )
        continue;
      if (commentFallback) comment.anchorId = commentFallback.id;
      else {
        comment.anchorKind = "diagram";
        comment.anchorId = undefined;
      }
    }
    return changedPieCommand(
      next,
      command,
      fallback ? sliceSelection(fallback.id) : { kind: "diagram" },
    );
  }

  if (command.type === "diagram.title") {
    const title = normalizedSingleLine(command.title);
    if (title === model.title) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    next.title = title;
    return changedPieCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "diagram.show-data") {
    if (command.showData === model.showData) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    next.showData = command.showData;
    next.headerLine = command.showData ? "pie showData" : "pie";
    return changedPieCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "diagram.appearance") {
    const optionEntries = Object.entries(command.options) as ReadonlyArray<
      [keyof MermaidPieOptions, MermaidPieOptions[keyof MermaidPieOptions]]
    >;
    if (
      typeof command.showData !== "boolean" ||
      optionEntries.some(([field, value]) => !validOption(model, field, value))
    ) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.option-invalid",
      );
    }
    if (
      model.showData === command.showData &&
      optionEntries.every(([field, value]) => model.options[field] === value)
    ) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    next.showData = command.showData;
    next.headerLine = command.showData ? "pie showData" : "pie";
    next.options = { ...command.options };
    return changedPieCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "diagram.option") {
    if (!validOption(model, command.field, command.value)) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.option-invalid",
      );
    }
    if (model.options[command.field] === command.value) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    Object.assign(next.options, { [command.field]: command.value });
    return changedPieCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "diagram.accessibility") {
    const value =
      command.field === "accessibilityTitle"
        ? normalizedSingleLine(command.value)
        : command.value.trim();
    if (model[command.field] === value) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    next[command.field] = value;
    return changedPieCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "diagram.accessibility-settings") {
    const title = normalizedSingleLine(command.title);
    const description = command.description.trim();
    if (
      title === model.accessibilityTitle &&
      description === model.accessibilityDescription
    ) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    next.accessibilityTitle = title;
    next.accessibilityDescription = description;
    return changedPieCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "comment.add") {
    const text = normalizedCommentText(command.text);
    if (!text || /[\r\n]/.test(text)) {
      return unchangedPieCommand(
        model,
        command,
        { kind: "diagram" },
        text ? "pie.comment-multiline" : "pie.comment-empty",
      );
    }
    if (
      command.anchor.kind === "slice" &&
      protectedSliceDiagnosis(model, command.anchor.sliceId)
    ) {
      return unchangedPieCommand(
        model,
        command,
        sliceSelection(command.anchor.sliceId),
        "pie.comment-anchor-invalid",
      );
    }
    const next = clonePieModel(model);
    const id = nextDraftId(next, "comment", text);
    next.comments.push({
      anchorId:
        command.anchor.kind === "slice" ? command.anchor.sliceId : undefined,
      anchorKind: command.anchor.kind,
      id,
      position: command.position,
      text,
    });
    return changedPieCommand(next, command, { id, kind: "comment" });
  }

  const comment = model.comments.find(
    (candidate) => candidate.id === command.commentId,
  );
  const selectionAfter: MermaidPieCommandSelection = {
    id: command.commentId,
    kind: "comment",
  };
  if (!comment) {
    return unchangedPieCommand(
      model,
      command,
      selectionAfter,
      "pie.comment-not-found",
    );
  }
  if (command.type === "comment.update") {
    const text = normalizedCommentText(command.text);
    if (!text || /[\r\n]/.test(text)) {
      return unchangedPieCommand(
        model,
        command,
        selectionAfter,
        text ? "pie.comment-multiline" : "pie.comment-empty",
      );
    }
    if (text === comment.text) {
      return unchangedPieCommand(
        model,
        command,
        selectionAfter,
        "pie.no-change",
      );
    }
    const next = clonePieModel(model);
    next.comments.find(
      (candidate) => candidate.id === command.commentId,
    )!.text = text;
    return changedPieCommand(next, command, selectionAfter);
  }
  const next = clonePieModel(model);
  next.comments = next.comments.filter(
    (candidate) => candidate.id !== command.commentId,
  );
  return changedPieCommand(next, command, { kind: "diagram" });
}
