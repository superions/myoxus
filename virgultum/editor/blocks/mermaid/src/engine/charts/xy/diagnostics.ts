// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXySourceRange } from "./source-document.js";

export type MermaidXyDiagnosticCode =
  | "ambiguous-source"
  | "invalid-config"
  | "invalid-number"
  | "invalid-range"
  | "invalid-statement"
  | "length-mismatch"
  | "unsupported-statement";

export type MermaidXyDiagnostic = {
  code: MermaidXyDiagnosticCode;
  id: string;
  message: string;
  range: MermaidXySourceRange;
  recordId: string;
  role: "config" | "diagram" | "plot" | "x-axis" | "y-axis";
  severity: "error" | "warning";
};

export function createMermaidXyDiagnostic(
  code: MermaidXyDiagnosticCode,
  message: string,
  range: MermaidXySourceRange,
  recordId: string,
  role: MermaidXyDiagnostic["role"],
  severity: MermaidXyDiagnostic["severity"] = "error",
): MermaidXyDiagnostic {
  return {
    code,
    id: `xy-diagnostic-${code}-${recordId}-${range.start}`,
    message,
    range,
    recordId,
    role,
    severity,
  };
}

export function hasBlockingMermaidXyDiagnostic(
  diagnostics: readonly MermaidXyDiagnostic[],
  recordId: string,
) {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.recordId === recordId && diagnostic.severity === "error",
  );
}
