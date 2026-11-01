// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidRadarDiagnostic } from "@virgultum/block-mermaid";

export function uniqueRadarDiagnostics(
  diagnostics: readonly MermaidRadarDiagnostic[],
) {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = diagnostic.message ?? diagnostic.code;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
