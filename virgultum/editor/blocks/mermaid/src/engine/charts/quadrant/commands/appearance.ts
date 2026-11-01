// SPDX-License-Identifier: AGPL-3.0-or-later

import { diagnoseMermaidQuadrantStyle } from "../diagnostics.js";
import type {
  MermaidQuadrantConfig,
  MermaidQuadrantInlineStyle,
  MermaidQuadrantModel,
} from "../model.js";
import {
  changedQuadrantCommand,
  mutableQuadrantModel,
  nextQuadrantDraftId,
  normalizedQuadrantText,
  pointSelection,
  unchangedQuadrantCommand,
} from "./shared.js";
import type {
  MermaidQuadrantAppearanceCommand,
  MermaidQuadrantCommandResult,
} from "./types.js";

function validStyle(style: MermaidQuadrantInlineStyle) {
  return (
    (style.radius === undefined ||
      !diagnoseMermaidQuadrantStyle("radius", style.radius)) &&
    (style.color === undefined ||
      !diagnoseMermaidQuadrantStyle("color", style.color)) &&
    (style.strokeColor === undefined ||
      !diagnoseMermaidQuadrantStyle("stroke-color", style.strokeColor)) &&
    (style.strokeWidth === undefined ||
      !diagnoseMermaidQuadrantStyle("stroke-width", style.strokeWidth))
  );
}

function hasStyle(style: MermaidQuadrantInlineStyle) {
  return Object.values(style).some((value) => value !== undefined);
}

function validConfig(config: MermaidQuadrantConfig) {
  for (const [field, value] of Object.entries(config)) {
    if (field === "useMaxWidth" && typeof value !== "boolean") return false;
    if (field === "xAxisPosition" && !["top", "bottom"].includes(String(value)))
      return false;
    if (field === "yAxisPosition" && !["left", "right"].includes(String(value)))
      return false;
    if (
      !["useMaxWidth", "xAxisPosition", "yAxisPosition"].includes(field) &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    )
      return false;
  }
  const width = config.chartWidth;
  const height = config.chartHeight;
  const protectedInset =
    (config.quadrantPadding ?? 0) +
    (config.pointRadius ?? 0) +
    (config.quadrantExternalBorderStrokeWidth ?? 0);
  return (
    (width === undefined || width - protectedInset * 2 > 0) &&
    (height === undefined || height - protectedInset * 2 > 0)
  );
}

function stylesEqual(
  left: MermaidQuadrantInlineStyle,
  right: MermaidQuadrantInlineStyle,
) {
  return (
    left.radius === right.radius &&
    left.color === right.color &&
    left.strokeColor === right.strokeColor &&
    left.strokeWidth === right.strokeWidth
  );
}

export function applyMermaidQuadrantAppearanceCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantAppearanceCommand,
): MermaidQuadrantCommandResult {
  if (command.type === "appearance.point-style") {
    const point = model.points.find(
      (candidate) => candidate.id === command.pointId,
    );
    if (!point)
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.point-not-found",
      );
    if (!validStyle(command.style))
      return unchangedQuadrantCommand(
        model,
        command,
        pointSelection(point.id),
        "quadrant.style-invalid",
      );
    if (stylesEqual(point.inlineStyle, command.style))
      return unchangedQuadrantCommand(
        model,
        command,
        pointSelection(point.id),
        "quadrant.no-change",
      );
    const next = mutableQuadrantModel(model);
    next.points.find((candidate) => candidate.id === point.id)!.inlineStyle = {
      ...command.style,
    };
    return changedQuadrantCommand(next, command, pointSelection(point.id));
  }

  if (command.type === "appearance.class-add") {
    const name = normalizedQuadrantText(command.name);
    if (
      !/^\w+$/.test(name) ||
      model.classes.some((classDef) => classDef.name === name) ||
      !hasStyle(command.style) ||
      !validStyle(command.style)
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.class-invalid",
      );
    }
    const next = mutableQuadrantModel(model);
    const id = nextQuadrantDraftId(next, "class");
    next.classes.push({
      id,
      name,
      sourceRecordId: "",
      style: { ...command.style },
    });
    return changedQuadrantCommand(next, command, { id, kind: "classDef" });
  }

  if (command.type === "appearance.class-update") {
    const current = model.classes.find(
      (classDef) => classDef.id === command.classDefId,
    );
    const name = normalizedQuadrantText(command.name);
    if (!current)
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.class-not-found",
      );
    if (
      !/^\w+$/.test(name) ||
      model.classes.some(
        (classDef) => classDef.id !== current.id && classDef.name === name,
      ) ||
      !hasStyle(command.style) ||
      !validStyle(command.style)
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { id: current.id, kind: "classDef" },
        "quadrant.class-invalid",
      );
    }
    if (current.name === name && stylesEqual(current.style, command.style))
      return unchangedQuadrantCommand(
        model,
        command,
        { id: current.id, kind: "classDef" },
        "quadrant.no-change",
      );
    const next = mutableQuadrantModel(model);
    const target = next.classes.find((classDef) => classDef.id === current.id)!;
    const previousName = target.name;
    target.name = name;
    target.style = { ...command.style };
    if (previousName !== name) {
      next.points.forEach((point) => {
        if (point.className === previousName) point.className = name;
      });
    }
    return changedQuadrantCommand(next, command, {
      id: current.id,
      kind: "classDef",
    });
  }

  if (command.type === "appearance.class-delete") {
    const current = model.classes.find(
      (classDef) => classDef.id === command.classDefId,
    );
    if (!current)
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.class-not-found",
      );
    const replacement = command.replacementClassId
      ? model.classes.find(
          (classDef) => classDef.id === command.replacementClassId,
        )
      : undefined;
    const affectedPointIds = model.points
      .filter((point) => point.className === current.name)
      .map((point) => point.id)
      .sort();
    const confirmedPointIds = [
      ...(command.confirmAffectedPointIds ?? []),
    ].sort();
    if (
      affectedPointIds.length > 0 &&
      (affectedPointIds.length !== confirmedPointIds.length ||
        affectedPointIds.some((id, index) => id !== confirmedPointIds[index]))
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { id: current.id, kind: "classDef" },
        "quadrant.class-delete-confirmation-required",
      );
    }
    if (command.replacementClassId && !replacement)
      return unchangedQuadrantCommand(
        model,
        command,
        { id: current.id, kind: "classDef" },
        "quadrant.replacement-class-not-found",
      );
    const next = mutableQuadrantModel(model);
    next.classes = next.classes.filter(
      (classDef) => classDef.id !== current.id,
    );
    next.points.forEach((point) => {
      if (point.className === current.name) point.className = replacement?.name;
    });
    next.comments = next.comments.filter(
      (comment) =>
        comment.anchor.kind !== "classDef" || comment.anchor.id !== current.id,
    );
    return changedQuadrantCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "appearance.config") {
    if (!validConfig(command.config))
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.config-invalid",
      );
    if (JSON.stringify(model.config) === JSON.stringify(command.config))
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.no-change",
      );
    const next = mutableQuadrantModel(model);
    next.config = { ...command.config };
    return changedQuadrantCommand(next, command, { kind: "diagram" });
  }

  if (command.type === "diagram.title") {
    const title = normalizedQuadrantText(command.title);
    if (title === model.title)
      return unchangedQuadrantCommand(
        model,
        command,
        { kind: "diagram" },
        "quadrant.no-change",
      );
    const next = mutableQuadrantModel(model);
    next.title = title;
    return changedQuadrantCommand(next, command, { kind: "diagram" });
  }

  const title = normalizedQuadrantText(command.title);
  const description = command.description.trim();
  if (
    title === model.accessibilityTitle &&
    description === model.accessibilityDescription
  ) {
    return unchangedQuadrantCommand(
      model,
      command,
      { kind: "diagram" },
      "quadrant.no-change",
    );
  }
  const next = mutableQuadrantModel(model);
  next.accessibilityTitle = title;
  next.accessibilityDescription = description;
  return changedQuadrantCommand(next, command, { kind: "diagram" });
}
