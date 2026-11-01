// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidMindmapModel } from "../model.js";
import type { MindmapRecord } from "../source-document.js";
import {
  unchangedMindmap,
  writeMindmapPatches,
  type MindmapCommandOptions,
} from "../writer.js";

export function isMindmapComment(record: MindmapRecord) {
  return (
    record.kind === "comment" ||
    (record.kind === "preamble" && /^\s*%%(?!\{)/.test(record.raw))
  );
}
export function mindmapCommentText(record: MindmapRecord) {
  return record.value ?? record.raw.replace(/^\s*%%\s?/, "");
}

/** Comments are physical occurrences, never label/ID matches. An anchor names
 * a complete Source record so decorator/interstatement positions stay exact. */
export function editMindmapComment(
  model: MermaidMindmapModel,
  change: {
    key?: string;
    text: string;
    anchorKey?: string;
    position?: "before" | "after";
  },
  options: MindmapCommandOptions = {},
) {
  if (/[\r\n]/.test(change.text) || change.text.trimStart().startsWith("{"))
    return unchangedMindmap(model, "syntax");
  const records = model.sourceDocument.records;
  if (change.key) {
    const record = records.find(
      (r) => r.sourceKey === change.key && isMindmapComment(r),
    );
    if (!record) return unchangedMindmap(model, "selection");
    const start =
      record.valueRange?.start ??
      record.range.start + record.raw.indexOf("%%") + 2;
    return writeMindmapPatches(
      model,
      [{ start, end: record.range.end, text: change.text }],
      options,
    );
  }
  const anchor = records.find((r) => r.sourceKey === change.anchorKey);
  if (!anchor || anchor.kind === "preamble" || anchor.kind === "invalid")
    return unchangedMindmap(model, "selection");
  const after = change.position !== "before";
  const at = after ? anchor.range.end + anchor.eol.length : anchor.range.start;
  const prefix = after && !anchor.eol ? model.sourceDocument.newline : "";
  const key = `mindmap-source-${crypto.randomUUID()}`;
  return writeMindmapPatches(
    model,
    [
      {
        start: at,
        end: at,
        text:
          prefix +
          anchor.indent +
          "%% " +
          change.text +
          model.sourceDocument.newline,
        identities: [[prefix.length, key]],
      },
    ],
    options,
  );
}

export function removeMindmapComment(
  model: MermaidMindmapModel,
  key: string,
  options: MindmapCommandOptions = {},
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === key && isMindmapComment(r),
  );
  return record
    ? writeMindmapPatches(
        model,
        [
          {
            start: record.range.start,
            end: record.range.end + record.eol.length,
            text: "",
          },
        ],
        options,
      )
    : unchangedMindmap(model, "selection");
}
