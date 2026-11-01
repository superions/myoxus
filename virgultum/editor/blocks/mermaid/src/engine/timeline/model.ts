// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  TimelineSourceDocument,
  TimelineSourceRange,
} from "./source-document.js";
import type { TimelineDiagnostic } from "./diagnostics.js";
import type { TimelineConfigProjection } from "./config.js";

export type MermaidTimelineSection = {
  id: string;
  label: string;
  order: number;
  implicit?: boolean;
};

export type MermaidTimelinePeriod = {
  id: string;
  label: string;
  order: number;
  sectionId: string;
};

export type MermaidTimelineEvent = {
  id: string;
  label: string;
  order: number;
  periodId: string;
};

export type MermaidTimelineModel = {
  diagramType: "timeline";
  events: MermaidTimelineEvent[];
  headerLine: string;
  periods: MermaidTimelinePeriod[];
  sections: MermaidTimelineSection[];
  title: string;
  /** Original source remains authoritative; all collections are derived projections. */
  sourceDocument: TimelineSourceDocument;
  direction: "LR" | "TD";
  diagnostics: readonly TimelineDiagnostic[];
  comments: readonly TimelineComment[];
  metadata: readonly TimelineMetadata[];
  config: TimelineConfigProjection;
  headerId: string | null;
};

export type TimelineAnchor = {
  readonly kind: "diagram" | "section" | "period" | "event";
  readonly id: string | null;
};
export type TimelineSelection =
  TimelineAnchor | { readonly kind: "comment"; readonly id: string } | null;

export type TimelineComment = {
  readonly id: string;
  readonly text: string;
  readonly marker: "%" | "%%" | "#";
  readonly range: TimelineSourceRange;
  readonly anchor: TimelineAnchor;
};
export type TimelineMetadata = {
  readonly id: string;
  readonly field: "title" | "accessibilityTitle" | "accessibilityDescription";
  readonly value: string;
  readonly format: "body" | "multiline" | "frontmatter";
  readonly range: TimelineSourceRange;
  readonly valueRange: TimelineSourceRange;
  readonly effective: boolean;
};

export const TIMELINE_UNSECTIONED_ID = "timeline-unsectioned";

const TIMELINE_PERIOD_DIRECTIVE_RE =
  /^(?:[%#]|timeline\b|(?:section|title)\s+\S|accTitle\s*:|accDescr\s*[:{])/i;

export function isMermaidTimelineSectionLabel(value: string) {
  return Boolean(value.trim()) && !/[:\r\n]/.test(value);
}

export function isMermaidTimelinePeriodLabel(value: string) {
  const label = value.trim();
  return (
    Boolean(label) &&
    !/[#:\r\n]/.test(label) &&
    !TIMELINE_PERIOD_DIRECTIVE_RE.test(label)
  );
}

export function isMermaidTimelineEventLabel(value: string) {
  const label = value.trim();
  return Boolean(label) && !/[\r\n]|:\s/.test(label);
}
