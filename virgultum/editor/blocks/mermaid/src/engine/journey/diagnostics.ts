// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JourneyRange } from "./source-document.js";
import { parseMermaidJourneySource } from "./parser.js";
export type JourneyDiagnostic = {
  code:
    | "header"
    | "syntax"
    | "score"
    | "score-range"
    | "actor-slot"
    | "config"
    | "accessibility";
  range: JourneyRange;
  anchorId: string | null;
};
export function getMermaidJourneySourceDiagnostic(source: string) {
  const e = parseMermaidJourneySource(source)?.diagnostics[0];
  return e
    ? `Journey line ${e.range.line}: ${e.code}.`
    : "Source does not contain a Journey diagram header.";
}
