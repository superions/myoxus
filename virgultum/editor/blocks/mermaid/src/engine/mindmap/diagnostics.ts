// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MindmapRange, MindmapRecord } from "./source-document.js";

/** Stable engine causes; the consuming family owns translated presentation. */
export const MINDMAP_DIAGNOSTIC_REPAIRS = {
  "mindmap.syntax.header": "Keep one mindmap header before the nodes.",
  "mindmap.syntax.node": "Use a bare node or close its shape and quoted label.",
  "mindmap.syntax.empty-class":
    "Remove the empty class record or add a blank line after it.",
  "mindmap.syntax.statement": "Put each node and decorator on its own line.",
  "mindmap.tree.root":
    "Indent this node below the existing root, or remove the additional root.",
  "mindmap.decorator.node": "Place this decorator after a node.",
} as const;
export type MindmapDiagnosticCode = keyof typeof MINDMAP_DIAGNOSTIC_REPAIRS;
export type MindmapDiagnostic = {
  severity: "error";
  code: MindmapDiagnosticCode;
  sourceKey?: string;
  range: MindmapRange;
  message: string;
};
export function mindmapDiagnostic(
  code: MindmapDiagnosticCode,
  record?: MindmapRecord,
): MindmapDiagnostic {
  return {
    severity: "error",
    code,
    sourceKey: record?.sourceKey,
    range: record?.range ?? { start: 0, end: 0, line: 1 },
    message: MINDMAP_DIAGNOSTIC_REPAIRS[code],
  };
}
