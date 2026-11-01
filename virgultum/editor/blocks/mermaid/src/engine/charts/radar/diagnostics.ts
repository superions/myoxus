// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidRadarSourceRange } from "./source-document.js";

export type MermaidRadarDiagnosticCode =
  | "ambiguous-source"
  | "duplicate-name"
  | "duplicate-reference"
  | "invalid-config"
  | "invalid-header"
  | "invalid-number"
  | "invalid-option"
  | "invalid-range"
  | "invalid-statement"
  | "length-mismatch"
  | "missing-reference"
  | "mixed-value-form"
  | "unknown-reference";

export type MermaidRadarDiagnostic = {
  readonly code: MermaidRadarDiagnosticCode;
  readonly id: string;
  /** Added by the family host; the engine keeps diagnostics locale-neutral. */
  readonly message?: string;
  readonly objectId?: string;
  readonly range: MermaidRadarSourceRange;
  readonly role: "axis" | "config" | "curve" | "diagram" | "option" | "vertex";
  readonly severity: "error" | "warning";
};

export function createMermaidRadarDiagnostic(
  code: MermaidRadarDiagnosticCode,
  range: MermaidRadarSourceRange,
  role: MermaidRadarDiagnostic["role"],
  objectId?: string,
): MermaidRadarDiagnostic {
  return {
    code,
    id: `radar-diagnostic-${code}-${range.start}-${range.end}`,
    objectId,
    range,
    role,
    severity:
      code === "length-mismatch" ||
      code === "missing-reference" ||
      code === "duplicate-reference" ||
      code === "unknown-reference"
        ? "warning"
        : "error",
  };
}
