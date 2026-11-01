// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  diagnoseMermaidQuadrantCoordinate,
  diagnoseMermaidQuadrantStyle,
} from "../diagnostics.js";
import type { MermaidQuadrantModel } from "../model.js";
import {
  changedQuadrantCommand,
  mutableQuadrantModel,
  nextQuadrantDraftId,
  normalizedQuadrantText,
  pointSelection,
  unchangedQuadrantCommand,
} from "./shared.js";
import type {
  MermaidQuadrantCommandResult,
  MermaidQuadrantPointCommand,
} from "./types.js";

export function applyMermaidQuadrantPointCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantPointCommand,
): MermaidQuadrantCommandResult {
  if (command.type === "point.add") {
    const label = normalizedQuadrantText(command.label);
    if (!label)
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.point-label-empty",
      );
    if (
      diagnoseMermaidQuadrantCoordinate(command.x) ||
      diagnoseMermaidQuadrantCoordinate(command.y)
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.coordinate-invalid",
      );
    }
    if (
      command.className &&
      !model.classes.some((classDef) => classDef.name === command.className)
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.class-not-found",
      );
    }
    const style = command.inlineStyle ?? {};
    if (
      (style.radius !== undefined &&
        diagnoseMermaidQuadrantStyle("radius", style.radius)) ||
      (style.color !== undefined &&
        diagnoseMermaidQuadrantStyle("color", style.color)) ||
      (style.strokeColor !== undefined &&
        diagnoseMermaidQuadrantStyle("stroke-color", style.strokeColor)) ||
      (style.strokeWidth !== undefined &&
        diagnoseMermaidQuadrantStyle("stroke-width", style.strokeWidth))
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.style-invalid",
      );
    }
    const next = mutableQuadrantModel(model);
    const anchorIndex = command.afterPointId
      ? next.points.findIndex((point) => point.id === command.afterPointId)
      : undefined;
    if (command.afterPointId && anchorIndex === -1) {
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.point-anchor-not-found",
      );
    }
    const insertionIndex =
      anchorIndex === undefined ? next.points.length : anchorIndex + 1;
    const id = nextQuadrantDraftId(next, "point");
    next.points.splice(insertionIndex, 0, {
      className: command.className,
      id,
      inlineStyle: { ...style },
      label,
      labelForm: command.labelForm,
      order: insertionIndex,
      runtimePaintOrder: 0,
      sourceFingerprint: "",
      sourceRecordId: "",
      x: command.x,
      y: command.y,
    });
    next.points.forEach((point, order) => {
      point.order = order;
      point.runtimePaintOrder = next.points.length - order - 1;
    });
    return changedQuadrantCommand(next, command, pointSelection(id));
  }

  const existing = model.points.find((point) => point.id === command.pointId);
  if (!existing) {
    return unchangedQuadrantCommand(
      model,
      command,
      { kind: "diagram" },
      "quadrant.point-not-found",
    );
  }
  const selection = pointSelection(existing.id);
  const next = mutableQuadrantModel(model);
  const point = next.points.find(
    (candidate) => candidate.id === command.pointId,
  )!;

  if (command.type === "point.rename") {
    const label = normalizedQuadrantText(command.label);
    if (!label)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.point-label-empty",
      );
    if (point.label === label)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.no-change",
      );
    point.label = label;
    return changedQuadrantCommand(next, command, selection);
  }
  if (command.type === "point.label-form") {
    if (point.labelForm === command.form)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.no-change",
      );
    point.labelForm = command.form;
    return changedQuadrantCommand(next, command, selection);
  }
  if (command.type === "point.move") {
    if (
      diagnoseMermaidQuadrantCoordinate(command.x) ||
      diagnoseMermaidQuadrantCoordinate(command.y)
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.coordinate-invalid",
      );
    }
    if (point.x === command.x && point.y === command.y)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.no-change",
      );
    point.x = command.x;
    point.y = command.y;
    return changedQuadrantCommand(next, command, selection);
  }
  if (command.type === "point.class") {
    if (
      command.className &&
      !next.classes.some((classDef) => classDef.name === command.className)
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.class-not-found",
      );
    }
    if (point.className === command.className)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.no-change",
      );
    point.className = command.className;
    return changedQuadrantCommand(next, command, selection);
  }
  if (command.type === "point.reorder") {
    if (command.beforePointId === command.pointId)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.no-change",
      );
    const reordered = next.points.filter(
      (candidate) => candidate.id !== command.pointId,
    );
    const target = command.beforePointId
      ? reordered.findIndex(
          (candidate) => candidate.id === command.beforePointId,
        )
      : reordered.length;
    if (target < 0)
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.point-anchor-not-found",
      );
    reordered.splice(target, 0, point);
    if (
      reordered.every(
        (candidate, index) => candidate.id === model.points[index]?.id,
      )
    )
      return unchangedQuadrantCommand(
        model,
        command,
        selection,
        "quadrant.no-change",
      );
    next.points = reordered;
    next.points.forEach((candidate, order) => {
      candidate.order = order;
      candidate.runtimePaintOrder = next.points.length - order - 1;
    });
    return changedQuadrantCommand(next, command, selection);
  }

  const deletedIndex = next.points.findIndex(
    (candidate) => candidate.id === command.pointId,
  );
  next.points.splice(deletedIndex, 1);
  next.points.forEach((candidate, order) => {
    candidate.order = order;
    candidate.runtimePaintOrder = next.points.length - order - 1;
  });
  next.comments = next.comments.filter(
    (comment) =>
      comment.anchor.kind !== "point" || comment.anchor.id !== command.pointId,
  );
  const fallback = next.points[Math.min(deletedIndex, next.points.length - 1)];
  return changedQuadrantCommand(
    next,
    command,
    fallback ? pointSelection(fallback.id) : { kind: "diagram" },
  );
}
