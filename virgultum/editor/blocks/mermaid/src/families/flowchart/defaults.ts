// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidSourceToVisualModel } from "../../engine/flowchart.js";

export const DEFAULT_MERMAID_FLOWCHART_SOURCE =
  "flowchart TD\n  A[Start]\n  B[Step]\n  C[Result]\n";

export function createDefaultMermaidVisualModel() {
  return parseMermaidSourceToVisualModel(DEFAULT_MERMAID_FLOWCHART_SOURCE)
    .model!;
}
