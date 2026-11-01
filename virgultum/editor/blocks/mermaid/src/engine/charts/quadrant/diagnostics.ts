// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidQuadrantSourceRange } from "./source-document.js";

export type MermaidQuadrantDiagnosticCode =
  | "ambiguous-source"
  | "invalid-axis"
  | "invalid-class"
  | "invalid-config"
  | "invalid-coordinate"
  | "invalid-point"
  | "invalid-style"
  | "unsupported-statement";

export type MermaidQuadrantDiagnostic = {
  code: MermaidQuadrantDiagnosticCode;
  id: string;
  message: string;
  range: MermaidQuadrantSourceRange;
  recordId: string;
  severity: "error" | "warning";
};

export function createMermaidQuadrantDiagnostic(
  code: MermaidQuadrantDiagnosticCode,
  message: string,
  range: MermaidQuadrantSourceRange,
  recordId: string,
  severity: MermaidQuadrantDiagnostic["severity"] = "error",
): MermaidQuadrantDiagnostic {
  return {
    code,
    id: `quadrant-diagnostic-${code}-${recordId}`,
    message,
    range,
    recordId,
    severity,
  };
}

export function hasBlockingMermaidQuadrantDiagnostic(
  diagnostics: readonly MermaidQuadrantDiagnostic[],
  recordId: string,
) {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.recordId === recordId && diagnostic.severity === "error",
  );
}

export function diagnoseMermaidQuadrantCoordinate(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? null
    : "quadrant.coordinate-invalid";
}

export function diagnoseMermaidQuadrantStyle(
  field: "color" | "radius" | "stroke-color" | "stroke-width",
  value: string | number,
) {
  if (field === "radius") {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? null
      : "quadrant.radius-invalid";
  }
  if (field === "stroke-width") {
    return typeof value === "string" && /^\d+px$/.test(value)
      ? null
      : "quadrant.stroke-width-invalid";
  }
  return typeof value === "string" &&
    /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)
    ? null
    : "quadrant.color-invalid";
}
