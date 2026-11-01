// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  copyMermaidQuadrantModel,
  type MermaidQuadrantModel,
} from "../model.js";
import type {
  MermaidQuadrantCommand,
  MermaidQuadrantCommandResult,
  MermaidQuadrantCommandSelection,
} from "./types.js";

export function unchangedQuadrantCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantCommand,
  selectionAfter: MermaidQuadrantCommandSelection,
  code: string,
  recordId?: string,
): MermaidQuadrantCommandResult {
  return {
    changed: false,
    command,
    diagnosis: { code, recordId },
    model,
    selectionAfter,
  };
}

export function changedQuadrantCommand(
  model: MermaidQuadrantModel,
  command: MermaidQuadrantCommand,
  selectionAfter: MermaidQuadrantCommandSelection,
): MermaidQuadrantCommandResult {
  return {
    changed: true,
    command,
    diagnosis: { code: "quadrant.ok" },
    model,
    selectionAfter,
  };
}

export function mutableQuadrantModel(model: MermaidQuadrantModel) {
  return copyMermaidQuadrantModel(model);
}

export function pointSelection(id: string): MermaidQuadrantCommandSelection {
  return { id, kind: "point" };
}

export function normalizedQuadrantText(value: string) {
  return value.trim().replace(/[\t ]{2,}/g, " ");
}

export function nextQuadrantDraftId(
  model: MermaidQuadrantModel,
  kind: "class" | "comment" | "point",
) {
  const occupied = new Set([
    ...model.points.map((point) => point.id),
    ...model.classes.map((classDef) => classDef.id),
    ...model.comments.map((comment) => comment.id),
  ]);
  let index = 1;
  let id = `quadrant-${kind}-draft-${index}`;
  while (occupied.has(id)) {
    index += 1;
    id = `quadrant-${kind}-draft-${index}`;
  }
  return id;
}
