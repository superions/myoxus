// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidQuadrantModel } from "../model.js";
import {
  changedQuadrantCommand,
  mutableQuadrantModel,
  normalizedQuadrantText,
  unchangedQuadrantCommand,
} from "./shared.js";
import type {
  MermaidQuadrantCommandResult,
  MermaidQuadrantTextCommand,
} from "./types.js";

export function applyMermaidQuadrantTextCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantTextCommand,
): MermaidQuadrantCommandResult {
  const next = mutableQuadrantModel(model);
  if (command.type === "text.axis") {
    const start = normalizedQuadrantText(command.start);
    const end = normalizedQuadrantText(command.end);
    if (!start) {
      return unchangedQuadrantCommand(
        model,
        command,
        { id: model.axes[command.axis].id, kind: "axis" },
        "quadrant.axis-start-empty",
      );
    }
    const axis = next.axes[command.axis];
    const form =
      command.form ??
      (end ? "both" : axis.form === "left-open" ? "left-open" : "single");
    if ((form === "both" && !end) || (form !== "both" && end)) {
      return unchangedQuadrantCommand(
        model,
        command,
        { id: axis.id, kind: "axis" },
        "quadrant.axis-form-invalid",
      );
    }
    if (
      axis.start === start &&
      axis.end === end &&
      axis.startForm === (command.startForm ?? axis.startForm) &&
      axis.endForm === (command.endForm ?? axis.endForm) &&
      axis.form === form
    ) {
      return unchangedQuadrantCommand(
        model,
        command,
        { id: axis.id, kind: "axis" },
        "quadrant.no-change",
      );
    }
    axis.start = start;
    axis.end = end;
    axis.startForm = command.startForm ?? axis.startForm;
    axis.endForm = command.endForm ?? axis.endForm;
    axis.form = form;
    if (command.axis === "x") {
      next.xAxisStart = start;
      next.xAxisEnd = end;
    } else {
      next.yAxisStart = start;
      next.yAxisEnd = end;
    }
    return changedQuadrantCommand(next, command, {
      id: axis.id,
      kind: "axis",
    });
  }

  const text = normalizedQuadrantText(command.text);
  const target = next.quadrantTexts[command.quadrant - 1];
  if (!text) {
    return unchangedQuadrantCommand(
      model,
      command,
      { id: target.id, kind: "quadrantText" },
      "quadrant.text-empty",
    );
  }
  if (target.text === text && target.form === (command.form ?? target.form)) {
    return unchangedQuadrantCommand(
      model,
      command,
      { id: target.id, kind: "quadrantText" },
      "quadrant.no-change",
    );
  }
  target.text = text;
  target.form = command.form ?? target.form;
  next.quadrantLabels[command.quadrant - 1] = text;
  return changedQuadrantCommand(next, command, {
    id: target.id,
    kind: "quadrantText",
  });
}
