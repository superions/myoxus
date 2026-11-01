// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapModel } from "../model.js";
import { treemapRecordRangeWithEnding } from "../source-document.js";
import { treemapNoChange, treemapPatchedResult } from "../writer.js";

export type TreemapMetadataCommand =
  | {
      readonly type: "metadata.set";
      readonly field: "title" | "accTitle" | "accDescr";
      readonly value: string;
    }
  | {
      readonly type: "metadata.remove";
      readonly field: "accTitle" | "accDescr";
    };

function kindFor(field: TreemapMetadataCommand["field"]) {
  return field === "title"
    ? "title"
    : field === "accTitle"
      ? "accessibility-title"
      : "accessibility-description";
}

export function applyTreemapMetadataCommand(
  model: TreemapModel,
  command: TreemapMetadataCommand,
) {
  const kind = kindFor(command.field);
  const record = model.sourceDocument.records.find(
    (candidate) => candidate.kind === kind,
  );
  if (command.type === "metadata.remove") {
    return record
      ? treemapPatchedResult(
          model,
          [
            {
              range: treemapRecordRangeWithEnding(model.sourceDocument, record),
              value: "",
            },
          ],
          null,
        )
      : treemapNoChange(model, "no-change");
  }
  const value = command.value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
  if (!value) return treemapNoChange(model, "invalid-metadata");
  const raw =
    command.field === "title"
      ? `title ${value}`
      : command.field === "accTitle"
        ? `accTitle: ${value}`
        : value.includes("\n")
          ? `accDescr {${model.sourceDocument.newline}${value}${model.sourceDocument.newline}}`
          : `accDescr: ${value}`;
  if (record)
    return treemapPatchedResult(
      model,
      [{ range: record.range, value: raw }],
      null,
    );
  // Body title is intentionally not synthesized. The global title writer owns
  // frontmatter when no native title statement exists.
  if (command.field === "title")
    return treemapNoChange(model, "native-title-missing");
  const header = model.sourceDocument.records.find(
    (candidate) => candidate.kind === "header",
  );
  if (!header) return treemapNoChange(model, "header-missing");
  return treemapPatchedResult(
    model,
    [
      {
        range: { start: header.range.end, end: header.range.end },
        value: `${model.sourceDocument.newline}${raw}`,
      },
    ],
    null,
  );
}
