// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureSourceDiagnostic } from "./model.js";
import { parseMermaidArchitectureSourceResult } from "./parser.js";

export function diagnoseMermaidArchitectureSource(
  source: string,
): MermaidArchitectureSourceDiagnostic | null {
  return parseMermaidArchitectureSourceResult(source).diagnostic;
}
