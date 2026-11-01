// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TimelineSourceRange } from "./source-document.js";

export type TimelineDiagnosticCode =
  | "header"
  | "period"
  | "event"
  | "section"
  | "accessibility"
  | "config"
  | "conflict"
  | "target"
  | "readonly";
export type TimelineDiagnostic = {
  readonly code: TimelineDiagnosticCode;
  readonly range: TimelineSourceRange;
  readonly anchorId: string | null;
};

export function timelineDiagnostic(
  code: TimelineDiagnosticCode,
  range: TimelineSourceRange,
  anchorId: string | null,
): TimelineDiagnostic {
  return { code, range, anchorId };
}

/** Timeline's bound lexer accepts each of these full-line comment forms. */
export function isTimelineCommentLine(value: string) {
  return value.startsWith("%") || value.startsWith("#");
}
