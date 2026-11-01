// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidPieSourceRange } from "./source-document.js";

export type MermaidPieDiagnosticCode =
  | "duplicate-label"
  | "invalid-accessibility"
  | "invalid-header"
  | "invalid-option"
  | "invalid-statement"
  | "invalid-value"
  | "unterminated-directive"
  | "unterminated-frontmatter";

export type MermaidPieDiagnostic = {
  code: MermaidPieDiagnosticCode;
  id: string;
  message: string;
  range: MermaidPieSourceRange;
  recordId?: string;
  severity: "error" | "warning";
};

export function createMermaidPieDiagnostic(
  code: MermaidPieDiagnosticCode,
  message: string,
  range: MermaidPieSourceRange,
  recordId?: string,
): MermaidPieDiagnostic {
  return {
    code,
    id: `pie-diagnostic-${range.start}-${code}`,
    message,
    range,
    recordId,
    severity: "error",
  };
}

export function hasBlockingMermaidPieDiagnostic(
  diagnostics: readonly MermaidPieDiagnostic[],
  recordId: string,
) {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" && diagnostic.recordId === recordId,
  );
}
