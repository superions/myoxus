// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GanttRange, GanttSourceDocument } from "./source-document.js";
import type { GanttConfigOccurrence } from "./config.js";

/** Status tags Mermaid 11.17.2 accepts on a task data list. */
export const GANTT_STATUS_TOKENS = ["active", "crit", "done"] as const;
export type GanttStatusToken = (typeof GANTT_STATUS_TOKENS)[number];

/** Task tags that change rendering rather than status colouring. */
export const GANTT_SHAPE_TOKENS = ["milestone", "vert"] as const;

/**
 * Statement keywords owned by the Gantt grammar. A task label may never start
 * with one of them, otherwise Mermaid reads the line as an option statement.
 */
export const GANTT_TASK_DIRECTIVE_RE =
  /^(?:(?:accDescr|accTitle)$|(?:axisFormat|click|dateFormat|excludes|gantt|href|includes|inclusiveEndDates|section|tickInterval|title|todayMarker|topAxis|weekday|weekend)\b)/i;

export type GanttDiagnosticCode =
  | "ambiguous-source"
  | "conflict"
  | "cycle"
  | "duplicate-id"
  | "invalid-date"
  | "invalid-duration"
  | "invalid-schedule"
  | "missing-id"
  | "unknown-statement"
  | "unresolved-reference"
  | "unsupported-option";

export type GanttDiagnostic = {
  readonly code: GanttDiagnosticCode;
  readonly message: string;
  readonly range: GanttRange;
  readonly statementId?: string;
  /** Offending token, kept separate so UI copy stays localized. */
  readonly detail?: string;
  readonly field?: "id" | "label" | "schedule" | "reference" | "option";
};

export type GanttScheduleKind =
  "explicit" | "after" | "until" | "previous" | "none";

export type MermaidGanttSection = {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly recordId: string;
  readonly implicit: boolean;
};

export type MermaidGanttTask = {
  readonly afterIds: readonly string[];
  readonly untilIds: readonly string[];
  readonly duration: string;
  readonly end: string;
  readonly id: string;
  readonly explicitId: boolean;
  readonly isMilestone: boolean;
  readonly isVert: boolean;
  readonly label: string;
  readonly order: number;
  readonly scheduleKind: GanttScheduleKind;
  readonly sectionId: string;
  readonly start: string;
  readonly statuses: readonly string[];
  readonly recordId: string;
  readonly labelRange: GanttRange;
  readonly idRange: GanttRange | null;
  readonly diagnostics: readonly GanttDiagnostic[];
};

export type GanttCalendarModel = {
  readonly dateFormat: string;
  readonly inclusiveEndDates: boolean | null;
  readonly weekday: string | null;
  readonly weekend: string | null;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
};

export type GanttAxisModel = {
  readonly axisFormat: string | null;
  readonly tickInterval: string | null;
  readonly topAxis: boolean | null;
  readonly todayMarker: string | null;
};

export type GanttClickBinding = {
  readonly id: string;
  readonly recordId: string;
  readonly targetTaskId: string | null;
  readonly kind: "click" | "href";
  readonly callbackOrUrl: string;
  readonly args: readonly string[];
  readonly callCallback: boolean;
  readonly tooltip: string | null;
};

export type GanttComment = {
  readonly id: string;
  readonly recordId: string;
  readonly text: string;
  readonly anchor:
    | { readonly kind: "diagram" }
    | { readonly kind: "section" | "task" | "option"; readonly id: string };
};

export type MermaidGanttModel = {
  readonly diagramType: "gantt";
  readonly version: 2;
  readonly sourceDocument: GanttSourceDocument;
  readonly configOccurrences: readonly GanttConfigOccurrence[];
  readonly sections: readonly MermaidGanttSection[];
  readonly tasks: readonly MermaidGanttTask[];
  readonly clicks: readonly GanttClickBinding[];
  readonly comments: readonly GanttComment[];
  readonly calendar: GanttCalendarModel;
  readonly axis: GanttAxisModel;
  readonly displayMode: string | null;
  readonly useMaxWidth: boolean | null;
  readonly title: string;
  readonly accessibilityTitle: string;
  readonly accessibilityDescription: string;
  readonly diagnostics: readonly GanttDiagnostic[];
  /** Engine-resolved intervals keyed by edit-session record id. */
  readonly intervals: Readonly<Record<string, { start: number; end: number }>>;
  readonly ambiguous: boolean;
  readonly sourceHash: string;
};

export type GanttSelection = {
  readonly kind: "section" | "task" | "comment" | "click";
  readonly id: string;
} | null;

export function isMermaidGanttSectionTitle(value: string) {
  return Boolean(value.trim()) && !/[\r\n]/.test(value);
}

export function isMermaidGanttTaskLabel(value: string) {
  const label = value.trim();
  return (
    Boolean(label) &&
    !/[:\r\n]/.test(label) &&
    !GANTT_TASK_DIRECTIVE_RE.test(label)
  );
}
