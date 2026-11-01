// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommandContext,
  MermaidRadarMetadataCommand,
} from "./types.js";
import type { MermaidRadarSourceRecord } from "../source-document.js";
import {
  radarInsertionAfterRecord,
  radarNoChange,
  radarPatchedResult,
  radarRecordRemovalPatch,
  type MermaidRadarSourcePatch,
} from "../writer.js";

type RadarMetadataField = Extract<
  MermaidRadarSourceRecord,
  { kind: "metadata" }
>["field"];

function metadataRecords(
  context: MermaidRadarCommandContext,
  field: RadarMetadataField,
) {
  return context.model.sourceDocument.records.filter(
    (
      record,
    ): record is Extract<MermaidRadarSourceRecord, { kind: "metadata" }> =>
      record.kind === "metadata" && record.field === field,
  );
}

function metadataInsertionAnchor(context: MermaidRadarCommandContext) {
  const records = context.model.sourceDocument.records;
  const owner = records.findLast(
    (record) => record.kind === "header" || record.kind === "metadata",
  );
  if (!owner) return null;
  // A comment immediately following the header or an existing metadata
  // statement belongs to that source object. Insert after those comments so
  // adding accessibility metadata cannot silently change their anchor.
  return (
    records.findLast(
      (record) =>
        record.kind === "comment" &&
        record.anchorId === owner.id &&
        record.range.start >= owner.range.end,
    ) ?? owner
  );
}

function metadataPatch(
  context: MermaidRadarCommandContext,
  field: RadarMetadataField,
  value: string,
): MermaidRadarSourcePatch[] | null {
  const records = metadataRecords(context, field);
  if (!value) {
    const anchoredComments = context.model.comments.some(
      (comment) =>
        comment.anchor.kind === "metadata" && comment.anchor.id === field,
    );
    if (anchoredComments) return null;
    return records.map((record) =>
      radarRecordRemovalPatch(context.model, record),
    );
  }
  const record = records.at(-1);
  if (record) {
    if (
      field === "accessibilityDescription" &&
      record.format === "line" &&
      value.includes("\n")
    ) {
      const indent = record.raw.match(/^\s*/)?.[0] ?? "";
      return [
        {
          range: record.range,
          value: `${indent}accDescr {${context.model.sourceDocument.newline}${indent}  ${value
            .split("\n")
            .join(
              `${context.model.sourceDocument.newline}${indent}  `,
            )}${context.model.sourceDocument.newline}${indent}}`,
        },
      ];
    }
    const recordIndent = record.raw.match(/^\s*/)?.[0] ?? "";
    const existingContentIndent = record.raw
      .split(/\r\n|\r|\n/)
      .slice(1)
      .find((line) => line.trim())
      ?.match(/^\s*/)?.[0];
    const contentIndent = existingContentIndent ?? `${recordIndent}  `;
    return [
      {
        range: record.valueRange,
        value:
          record.format === "block"
            ? `${context.model.sourceDocument.newline}${contentIndent}${value
                .split("\n")
                .join(
                  `${context.model.sourceDocument.newline}${contentIndent}`,
                )}${context.model.sourceDocument.newline}${recordIndent}`
            : value,
      },
    ];
  }
  const insertionAnchor = metadataInsertionAnchor(context);
  if (!insertionAnchor) return null;
  const line =
    field === "title"
      ? `  title ${value}`
      : field === "accessibilityTitle"
        ? `  accTitle: ${value}`
        : value.includes("\n")
          ? `  accDescr {${context.model.sourceDocument.newline}    ${value
              .split("\n")
              .join(
                `${context.model.sourceDocument.newline}    `,
              )}${context.model.sourceDocument.newline}  }`
          : `  accDescr: ${value}`;
  return [radarInsertionAfterRecord(context.model, insertionAnchor, line)];
}

export function applyMermaidRadarMetadataCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarMetadataCommand;
  const title = "title" in command ? command.title : "";
  const description =
    command.type === "diagram.accessibility" ? command.description : "";
  if (
    /%%/.test(title) ||
    /%%/.test(description) ||
    (command.type === "diagram.title" && /[\r\n]/.test(command.title)) ||
    (command.type === "diagram.accessibility" &&
      (/[\r\n]/.test(command.title) ||
        (/[\r\n]/.test(command.description) && /}/.test(command.description))))
  )
    return radarNoChange(
      context.model,
      context.source,
      "radar.metadata-invalid",
    );
  const requested =
    command.type === "diagram.title"
      ? [["title", command.title.trim()] as const]
      : command.type === "diagram.accessibility"
        ? [
            ["accessibilityTitle", command.title.trim()] as const,
            ["accessibilityDescription", command.description.trim()] as const,
          ]
        : [];
  if (!requested.length)
    return radarNoChange(
      context.model,
      context.source,
      "radar.command-invalid",
    );
  const changed = requested.filter(([field, value]) => {
    const current =
      field === "title"
        ? context.model.title
        : field === "accessibilityTitle"
          ? context.model.accessibilityTitle
          : context.model.accessibilityDescription;
    return current !== value;
  });
  if (!changed.length)
    return radarNoChange(context.model, context.source, "radar.no-change");
  const patchGroups = changed.map(([field, value]) =>
    metadataPatch(context, field, value),
  );
  if (patchGroups.some((patches) => patches === null))
    return radarNoChange(
      context.model,
      context.source,
      "radar.metadata-comments-present",
    );
  const patches = patchGroups.flatMap((group) => group ?? []);
  if (!patches.length)
    return radarNoChange(
      context.model,
      context.source,
      "radar.patch-unavailable",
    );
  const coalesced = patches.reduce<MermaidRadarSourcePatch[]>(
    (result, patch) => {
      const insertion = result.find(
        (candidate) =>
          candidate.range.start === patch.range.start &&
          candidate.range.end === patch.range.end &&
          patch.range.start === patch.range.end,
      );
      if (!insertion) return [...result, patch];
      return result.map((candidate) =>
        candidate === insertion
          ? { ...candidate, value: `${candidate.value}${patch.value}` }
          : candidate,
      );
    },
    [],
  );
  return radarPatchedResult({
    model: context.model,
    patches: coalesced,
    selectionAfter: { kind: "diagram" },
    source: context.source,
  });
}
