// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "./model.js";
import type { C4SourceRecord } from "./source-document.js";

export function c4RecordEnd(record: C4SourceRecord) {
  return record.range.end + record.eol.length;
}
export function c4RecordUnit(model: MermaidC4Model, record: C4SourceRecord) {
  const records = model.sourceDocument.records;
  const close = record.closeKey
    ? records.find((r) => r.sourceKey === record.closeKey)
    : record;
  if (!close) return null;
  let start = record.range.start,
    end = c4RecordEnd(close);
  // Leading anchored comments and trailing inline comments belong to the unit.
  for (const neighbour of [...records].reverse()) {
    if (
      neighbour.anchor?.sourceKey === record.sourceKey &&
      neighbour.anchor.position === "before" &&
      c4RecordEnd(neighbour) === start
    )
      start = neighbour.range.start;
  }
  for (const neighbour of records) {
    if (
      neighbour.anchor?.sourceKey === close.sourceKey &&
      neighbour.anchor.position === "inline" &&
      neighbour.range.start === end
    )
      end = c4RecordEnd(neighbour);
  }
  return records.filter((r) => r.range.start >= start && r.range.start < end);
}
