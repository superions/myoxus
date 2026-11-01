// SPDX-License-Identifier: AGPL-3.0-or-later

import { isSupportedTimelineHeader, readTimelineConfig } from "./config.js";
import { timelineDiagnostic, type TimelineDiagnostic } from "./diagnostics.js";
import {
  isMermaidTimelineEventLabel,
  isMermaidTimelinePeriodLabel,
  TIMELINE_UNSECTIONED_ID,
  type MermaidTimelineModel,
  type TimelineAnchor,
  type TimelineComment,
  type TimelineMetadata,
} from "./model.js";
import {
  reconcileTimelineSource,
  scanTimelineSource,
  type TimelineIdentityMapping,
  type TimelineSourceStatement,
} from "./source-document.js";

/** The bound Timeline lexer, source-document scanner and projection share one grammar. */
export function parseTimelineSource(
  source: string,
  previous?: MermaidTimelineModel,
  mapping?: TimelineIdentityMapping,
): MermaidTimelineModel {
  const sourceDocument = reconcileTimelineSource(
    scanTimelineSource(source),
    previous?.sourceDocument,
    mapping,
  );
  const config = readTimelineConfig(sourceDocument);
  const diagnostics: TimelineDiagnostic[] = [...config.diagnostics];
  const sections: MermaidTimelineModel["sections"] = [];
  const periods: MermaidTimelineModel["periods"] = [];
  const events: MermaidTimelineModel["events"] = [];
  const metadata: TimelineMetadata[] = [];
  const comments: TimelineComment[] = [];
  let headerId: string | null = null;
  let headerLine = "";
  let direction: "LR" | "TD" = "LR";
  let currentSectionId = TIMELINE_UNSECTIONED_ID;
  let currentPeriodId: string | null = null;
  let started = false;
  const value = (record: TimelineSourceStatement) =>
    record.valueRange
      ? source.slice(record.valueRange.start, record.valueRange.end)
      : "";
  const reject = (
    code: TimelineDiagnostic["code"],
    record: TimelineSourceStatement,
  ) => diagnostics.push(timelineDiagnostic(code, record.range, record.id));
  if (config.frontmatterTitle)
    metadata.push({
      id: config.frontmatterTitle.record.id,
      field: "title",
      value: config.frontmatterTitle.value,
      format: "frontmatter",
      range: config.frontmatterTitle.record.range,
      valueRange: config.frontmatterTitle.range,
      effective: false,
    });
  for (const record of sourceDocument.statements) {
    if (
      record.kind === "frontmatter" ||
      record.kind === "directive" ||
      record.kind === "blank" ||
      record.kind === "comment"
    )
      continue;
    if (!started) {
      started = true;
      if (
        record.kind !== "header" ||
        !isSupportedTimelineHeader(record.raw.trim())
      ) {
        reject("header", record);
        continue;
      }
      headerId = record.id;
      headerLine = record.raw.trim();
      direction = /\bTD$/i.test(headerLine) ? "TD" : "LR";
      continue;
    }
    if (!headerId) continue;
    if (record.kind === "header") {
      reject("header", record);
      continue;
    }
    if (
      record.kind === "title" ||
      record.kind === "accessibility-title" ||
      record.kind === "accessibility-description"
    ) {
      const valid =
        record.kind === "title"
          ? /^\s*title\s[^\r\n]+$/i.test(record.raw)
          : record.kind === "accessibility-title"
            ? /^\s*accTitle\s*:/i.test(record.raw)
            : /^\s*accDescr\s*(?::|\{)/i.test(record.raw) && record.complete;
      if (!valid || !record.valueRange) {
        reject(record.kind === "title" ? "period" : "accessibility", record);
        continue;
      }
      metadata.push({
        id: record.id,
        field:
          record.kind === "title"
            ? "title"
            : record.kind === "accessibility-title"
              ? "accessibilityTitle"
              : "accessibilityDescription",
        value: value(record),
        format:
          record.kind === "accessibility-description" &&
          /^\s*accDescr\s*\{/i.test(record.raw)
            ? "multiline"
            : "body",
        range: record.range,
        valueRange: record.valueRange,
        effective: false,
      });
      continue;
    }
    if (record.kind === "section") {
      const label = value(record);
      if (/[:\r\n]/.test(label)) {
        reject("section", record);
        continue;
      }
      currentSectionId = record.id;
      sections.push({ id: record.id, label, order: sections.length });
      // Native addEvent targets the last task, even across a section header.
      if (!record.segments.length && !record.raw.includes(":")) continue;
    }
    if (record.kind === "period") {
      const label = value(record);
      if (!isMermaidTimelinePeriodLabel(label)) {
        reject("period", record);
        continue;
      }
      if (
        currentSectionId === TIMELINE_UNSECTIONED_ID &&
        !sections.some((item) => item.implicit)
      )
        sections.unshift({
          id: TIMELINE_UNSECTIONED_ID,
          label: "",
          order: 0,
          implicit: true,
        });
      currentPeriodId = record.id;
      periods.push({
        id: record.id,
        label,
        order: periods.length,
        sectionId: currentSectionId,
      });
    } else if (record.kind !== "event" && record.kind !== "section") {
      reject("period", record);
      continue;
    }
    const colon = record.raw.indexOf(":");
    const hash = record.raw.indexOf("#");
    if (
      colon >= 0 &&
      !(record.kind === "period" && hash >= 0 && hash < colon)
    ) {
      let cursor = record.range.start + colon;
      for (const segment of record.segments) {
        if (source.slice(cursor, segment.range.start).trim())
          reject("event", record);
        if (!currentPeriodId || !isMermaidTimelineEventLabel(segment.raw)) {
          diagnostics.push(
            timelineDiagnostic("event", segment.range, segment.id),
          );
        } else
          events.push({
            id: segment.id,
            label: segment.raw,
            order: events.length,
            periodId: currentPeriodId,
          });
        cursor = segment.range.end;
      }
      if (
        source.slice(cursor, record.range.end).trim() ||
        !record.segments.length
      )
        reject("event", record);
    } else if (record.kind === "event") reject("event", record);
  }
  if (!headerId && !diagnostics.some((item) => item.code === "header"))
    diagnostics.push(
      timelineDiagnostic(
        "header",
        { start: 0, end: source.length, line: 1 },
        null,
      ),
    );
  sections.forEach((section, order) => {
    section.order = order;
  });
  for (let index = 0; index < sourceDocument.statements.length; index++) {
    const record = sourceDocument.statements[index]!;
    if (record.kind !== "comment") continue;
    const match = /^\s*(%%|%|#)(.*)$/s.exec(record.raw);
    if (!match) continue;
    let nextIndex = index + 1;
    while (sourceDocument.statements[nextIndex]?.kind === "comment")
      nextIndex++;
    let previousIndex = index - 1;
    while (sourceDocument.statements[previousIndex]?.kind === "comment")
      previousIndex--;
    const next = sourceDocument.statements[nextIndex];
    const before = sourceDocument.statements[previousIndex];
    let anchor: TimelineAnchor = { kind: "diagram", id: null };
    if (
      before?.kind === "period" &&
      before.range.line === record.range.line &&
      periods.some((item) => item.id === before.id)
    ) {
      anchor = { kind: "period", id: before.id };
    } else if (
      next &&
      before?.kind !== "header" &&
      headerId &&
      record.range.start >
        (sourceDocument.statements.find((item) => item.id === headerId)?.range
          .end ?? source.length)
    ) {
      if (
        next.kind === "section" &&
        sections.some((item) => item.id === next.id)
      )
        anchor = { kind: "section", id: next.id };
      else if (
        next.kind === "period" &&
        periods.some((item) => item.id === next.id)
      )
        anchor = { kind: "period", id: next.id };
      else if (
        next.kind === "event" &&
        next.segments[0] &&
        events.some((item) => item.id === next.segments[0]!.id)
      )
        anchor = { kind: "event", id: next.segments[0].id };
    }
    comments.push({
      id: record.id,
      text: match[2]!.trim(),
      marker: match[1] as TimelineComment["marker"],
      range: record.range,
      anchor,
    });
  }
  const effective = new Map<string, number>();
  metadata.forEach((item, index) => effective.set(item.field, index));
  const resolvedMetadata = metadata.map((item, index) => ({
    ...item,
    effective: effective.get(item.field) === index,
  }));
  return {
    diagramType: "timeline",
    sourceDocument,
    headerId,
    headerLine,
    direction,
    config,
    diagnostics,
    comments,
    metadata: resolvedMetadata,
    sections,
    periods,
    events,
    title:
      resolvedMetadata.find((item) => item.field === "title" && item.effective)
        ?.value ?? "",
  };
}

export function parseMermaidTimelineSource(
  source: string,
  previous?: MermaidTimelineModel,
): MermaidTimelineModel | null {
  const model = parseTimelineSource(source, previous);
  return model.headerId ? model : null;
}

/** Rendering-only adapter: the native detector is stricter than its case-insensitive lexer. */
export function projectTimelineNativeRenderSource(model: MermaidTimelineModel) {
  const header = model.sourceDocument.statements.find(
    (record) => record.id === model.headerId,
  );
  if (!header) return model.sourceDocument.source;
  const patches = [
    ...model.sourceDocument.statements
      .filter(
        (record) =>
          record.kind === "comment" && record.range.start < header.range.start,
      )
      .map((record) => ({
        start: record.range.start,
        end: record.range.end + record.eol.length,
        value: "",
      })),
    {
      start: header.range.start,
      end: header.range.end,
      value: header.raw.replace(/^([ \t]*)timeline/i, "$1timeline"),
    },
  ];
  let source = model.sourceDocument.source;
  for (const patch of patches.sort((a, b) => b.start - a.start))
    source =
      source.slice(0, patch.start) + patch.value + source.slice(patch.end);
  return source;
}
