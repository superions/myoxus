// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KanbanRange } from "./source-document.js";
import { parseMermaidKanbanSource } from "./parser.js";
export type KanbanDiagnostic = {
  code:
    "header" | "syntax" | "metadata" | "duplicate-id" | "hierarchy" | "config";
  range: KanbanRange;
  anchorId: string | null;
};
export function getMermaidKanbanSourceDiagnostic(source: string) {
  const model = parseMermaidKanbanSource(source);
  const error = model?.diagnostics[0];
  return error
    ? `Kanban line ${error.range.line}: ${error.code}.`
    : "Source does not contain a Kanban diagram header.";
}
