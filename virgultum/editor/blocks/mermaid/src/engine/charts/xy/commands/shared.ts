// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidXyCommandSelection,
  MermaidXyCommandValidation,
} from "./types.js";

export function validXyCommand(
  selectionAfter: MermaidXyCommandSelection,
): MermaidXyCommandValidation {
  return { code: "xy.ok", selectionAfter, valid: true };
}

export function invalidXyCommand(
  code: string,
  selectionAfter: MermaidXyCommandSelection = { kind: "diagram" },
): MermaidXyCommandValidation {
  return { code, selectionAfter, valid: false };
}

export function finiteXyNumber(value: number) {
  return Number.isFinite(value);
}

export function normalizedXyText(value: string) {
  return value.trim().replace(/[\t ]{2,}/g, " ");
}

export function changesXyOrder(
  ids: readonly string[],
  id: string,
  beforeId?: string,
) {
  if (beforeId === id) return false;
  const previousIndex = ids.indexOf(id);
  if (previousIndex < 0) return false;
  const remaining = ids.filter((candidate) => candidate !== id);
  const target = beforeId ? remaining.indexOf(beforeId) : remaining.length;
  if (target < 0) return false;
  return target !== previousIndex;
}
