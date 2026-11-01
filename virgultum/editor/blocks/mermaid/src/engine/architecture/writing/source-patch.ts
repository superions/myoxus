// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateMermaidCommonMetadataLines } from "../../common-metadata.js";
import {
  architectureCommentLine,
  architectureSemanticFingerprint,
  quotedArchitectureString,
  splitArchitectureComment,
} from "../grammar.js";
import type {
  MermaidArchitectureComment,
  MermaidArchitectureModel,
} from "../model.js";
import { parseMermaidArchitectureSource } from "../parser.js";
import type {
  MermaidArchitectureSourceDocument,
  MermaidArchitectureSourceRecord,
  MermaidArchitectureStatementKind,
} from "../source-document.js";
import {
  architectureAlignmentSource,
  architectureEdgeSource,
  architectureGroupSource,
  architectureJunctionSource,
  architectureServiceSource,
  orderedArchitectureGroups,
} from "./canonical-writer.js";

function architectureStatementForRecord(
  model: MermaidArchitectureModel,
  record: Extract<MermaidArchitectureSourceRecord, { kind: "statement" }>,
) {
  if (record.statementKind === "group") {
    const group = model.groups.find((candidate) => candidate.id === record.id);
    return group
      ? {
          fingerprint: architectureSemanticFingerprint(group),
          line: architectureGroupSource(group),
        }
      : null;
  }
  if (record.statementKind === "service") {
    const service = model.services.find(
      (candidate) => candidate.id === record.id,
    );
    if (service) {
      return {
        fingerprint: architectureSemanticFingerprint(service),
        line: architectureServiceSource(service),
      };
    }
    const junction = model.junctions.find(
      (candidate) => candidate.id === record.id,
    );
    return junction
      ? {
          fingerprint: architectureSemanticFingerprint(junction),
          line: architectureJunctionSource(junction),
        }
      : null;
  }
  if (record.statementKind === "junction") {
    const junction = model.junctions.find(
      (candidate) => candidate.id === record.id,
    );
    if (junction) {
      return {
        fingerprint: architectureSemanticFingerprint(junction),
        line: architectureJunctionSource(junction),
      };
    }
    const service = model.services.find(
      (candidate) => candidate.id === record.id,
    );
    return service
      ? {
          fingerprint: architectureSemanticFingerprint(service),
          line: architectureServiceSource(service),
        }
      : null;
  }
  if (record.statementKind === "edge") {
    const edge = model.edges.find((candidate) => candidate.id === record.id);
    return edge
      ? {
          fingerprint: architectureSemanticFingerprint(edge),
          line: architectureEdgeSource(edge, model),
        }
      : null;
  }
  const alignment = model.alignments.find(
    (candidate) => candidate.id === record.id,
  );
  return alignment
    ? {
        fingerprint: architectureSemanticFingerprint(alignment),
        line: architectureAlignmentSource(alignment),
      }
    : null;
}

function createArchitectureSourcePatch(
  model: MermaidArchitectureModel,
  document: MermaidArchitectureSourceDocument,
) {
  const replacements = new Map<number, string[]>();
  const consumedLines = new Set<number>();
  const statementRecords = document.records.filter(
    (
      record,
    ): record is Extract<
      MermaidArchitectureSourceRecord,
      { kind: "statement" }
    > => record.kind === "statement",
  );
  const commentsById = new Map(
    (model.comments ?? []).map((comment) => [comment.id, comment]),
  );
  const inlineComment = (commentId: string | undefined) =>
    commentId ? (commentsById.get(commentId)?.line ?? "") : "";
  const directiveLines = (record: MermaidArchitectureSourceRecord) =>
    (record.inlineDirectives ?? []).flatMap((directive) =>
      directive.split(/\r\n|\r|\n/),
    );
  const originalInlineComment = (suffix: string) =>
    suffix.startsWith("%%")
      ? architectureCommentLine(suffix.slice(2).trim())
      : "";
  for (const record of document.records) {
    for (let index = record.startLine; index < record.endLine; index += 1) {
      consumedLines.add(index);
    }
    if (record.kind === "comment") {
      const comment = commentsById.get(record.id);
      if (!comment) {
        replacements.set(record.startLine, directiveLines(record));
      } else if (comment.line === record.fingerprint) {
        replacements.set(
          record.startLine,
          document.lines.slice(record.startLine, record.endLine),
        );
      } else {
        replacements.set(record.startLine, [
          ...directiveLines(record),
          comment.line,
        ]);
      }
      continue;
    }
    if (record.kind === "header") {
      const suffix = inlineComment(record.commentId);
      const originalComment = record.commentFingerprint ?? "";
      replacements.set(
        record.startLine,
        suffix === originalComment
          ? document.lines.slice(record.startLine, record.endLine)
          : [
              ...directiveLines(record),
              `${model.headerLine || "architecture-beta"}${
                suffix ? ` ${suffix}` : ""
              }`,
            ],
      );
      continue;
    }
    if (record.kind === "statement") {
      const current = architectureStatementForRecord(model, record);
      const suffix = inlineComment(record.commentId);
      const commentUnchanged =
        suffix === originalInlineComment(record.commentSuffix);
      if (!current) {
        replacements.set(record.startLine, [
          ...directiveLines(record),
          ...(suffix ? [`  ${suffix}`] : []),
        ]);
      } else if (
        current.fingerprint === record.fingerprint &&
        commentUnchanged
      ) {
        replacements.set(
          record.startLine,
          document.lines.slice(record.startLine, record.endLine),
        );
      } else {
        replacements.set(record.startLine, [
          ...directiveLines(record),
          `${current.line}${suffix ? ` ${suffix}` : ""}`,
        ]);
      }
      continue;
    }
    const value = model[record.field];
    const suffix = inlineComment(record.commentId);
    const commentUnchanged =
      record.format === "frontmatter" ||
      suffix === originalInlineComment(record.commentSuffix);
    if (!value) {
      replacements.set(record.startLine, [
        ...directiveLines(record),
        ...(suffix ? [`  ${suffix}`] : []),
      ]);
      continue;
    }
    if (!record.effective) {
      const originalLines = document.lines.slice(
        record.startLine,
        record.endLine,
      );
      if (!commentUnchanged && originalLines.length) {
        const lastIndex = originalLines.length - 1;
        const original = splitArchitectureComment(originalLines[lastIndex]);
        originalLines[lastIndex] =
          `${original.syntax.trimEnd()}${suffix ? ` ${suffix}` : ""}`;
      }
      replacements.set(record.startLine, originalLines);
      continue;
    }
    if (JSON.stringify(value) === record.fingerprint && commentUnchanged) {
      replacements.set(
        record.startLine,
        document.lines.slice(record.startLine, record.endLine),
      );
      continue;
    }
    const metadataLines =
      record.format === "frontmatter"
        ? [
            `title: ${quotedArchitectureString(value)}${
              record.commentSuffix ? ` ${record.commentSuffix}` : ""
            }`,
          ]
        : record.field === "diagramTitle"
          ? value
            ? [`  title ${value}`]
            : []
          : record.field === "accessibilityTitle"
            ? value
              ? [`  accTitle: ${value}`]
              : []
            : value
              ? generateMermaidCommonMetadataLines({
                  accessibilityDescription: value,
                  accessibilityTitle: "",
                  diagramTitle: "",
                })
              : [];
    if (suffix && record.format !== "frontmatter") {
      if (metadataLines.length) {
        const lastIndex = metadataLines.length - 1;
        metadataLines[lastIndex] = `${metadataLines[lastIndex]} ${suffix}`;
      } else {
        metadataLines.push(`  ${suffix}`);
      }
    }
    replacements.set(record.startLine, [
      ...directiveLines(record),
      ...metadataLines,
    ]);
  }

  const existingGroupIds = new Set(
    statementRecords
      .filter((record) => record.statementKind === "group")
      .map((record) => record.id),
  );
  const existingNodeIds = new Set(
    statementRecords
      .filter(
        (record) =>
          record.statementKind === "service" ||
          record.statementKind === "junction",
      )
      .map((record) => record.id),
  );
  const existingEdgeIds = new Set(
    statementRecords
      .filter((record) => record.statementKind === "edge")
      .map((record) => record.id),
  );
  const existingAlignmentIds = new Set(
    statementRecords
      .filter((record) => record.statementKind === "alignment")
      .map((record) => record.id),
  );
  const bodyEnd = Math.max(
    0,
    document.lines.findLastIndex((line) => line.trim()) + 1,
  );
  const firstRecordLine = (
    kinds: readonly MermaidArchitectureStatementKind[],
  ) =>
    statementRecords
      .filter((record) => kinds.includes(record.statementKind))
      .reduce((line, record) => Math.min(line, record.startLine), bodyEnd);
  const insertions = new Map<number, string[]>();
  const insert = (line: number, sourceLines: string[]) => {
    if (!sourceLines.length) return;
    insertions.set(line, [...(insertions.get(line) ?? []), ...sourceLines]);
  };
  const existingMetadataFields = new Set(
    document.records.flatMap((record) =>
      record.kind === "metadata" ? [record.field] : [],
    ),
  );
  const headerIndex = document.lines.findIndex(
    (line) =>
      splitArchitectureComment(line).syntax.trim() === "architecture-beta",
  );
  const recordedCommentIds = new Set(
    document.records.flatMap((record) => {
      if (record.kind === "comment") return [record.id];
      if (
        record.kind === "header" ||
        record.kind === "metadata" ||
        record.kind === "statement"
      ) {
        return record.commentId ? [record.commentId] : [];
      }
      return [];
    }),
  );
  const anchorRecord = (comment: MermaidArchitectureComment) =>
    document.records.find((record) => {
      if (comment.anchorKind === "metadata") {
        return record.kind === "metadata" && record.field === comment.anchorId;
      }
      if (
        comment.anchorKind === "group" ||
        comment.anchorKind === "service" ||
        comment.anchorKind === "junction" ||
        comment.anchorKind === "edge" ||
        comment.anchorKind === "alignment"
      ) {
        return (
          record.kind === "statement" &&
          (record.statementKind === comment.anchorKind ||
            ((comment.anchorKind === "service" ||
              comment.anchorKind === "junction") &&
              (record.statementKind === "service" ||
                record.statementKind === "junction"))) &&
          record.id === comment.anchorId
        );
      }
      return undefined;
    });
  for (const comment of model.comments ?? []) {
    if (recordedCommentIds.has(comment.id)) continue;
    const anchor = anchorRecord(comment);
    const line =
      comment.anchorKind === "diagram" && comment.anchorId === "end"
        ? bodyEnd
        : (anchor?.startLine ?? headerIndex);
    insert(line, [comment.line]);
  }
  insert(headerIndex + 1, [
    ...(!existingMetadataFields.has("diagramTitle") && model.diagramTitle
      ? [`  title ${model.diagramTitle}`]
      : []),
    ...(!existingMetadataFields.has("accessibilityTitle") &&
    model.accessibilityTitle
      ? [`  accTitle: ${model.accessibilityTitle}`]
      : []),
    ...(!existingMetadataFields.has("accessibilityDescription") &&
    model.accessibilityDescription
      ? generateMermaidCommonMetadataLines({
          accessibilityDescription: model.accessibilityDescription,
          accessibilityTitle: "",
          diagramTitle: "",
        })
      : []),
  ]);
  insert(
    firstRecordLine(["service", "junction", "edge", "alignment"]),
    orderedArchitectureGroups(model)
      .filter((group) => !existingGroupIds.has(group.id))
      .map(architectureGroupSource),
  );
  insert(firstRecordLine(["edge", "alignment"]), [
    ...model.services
      .filter((service) => !existingNodeIds.has(service.id))
      .sort((a, b) => a.order - b.order)
      .map(architectureServiceSource),
    ...model.junctions
      .filter((junction) => !existingNodeIds.has(junction.id))
      .sort((a, b) => a.order - b.order)
      .map(architectureJunctionSource),
  ]);
  insert(
    firstRecordLine(["alignment"]),
    model.edges
      .filter((edge) => !existingEdgeIds.has(edge.id))
      .sort((a, b) => a.order - b.order)
      .map((edge) => architectureEdgeSource(edge, model)),
  );
  insert(
    bodyEnd,
    model.alignments
      .filter((alignment) => !existingAlignmentIds.has(alignment.id))
      .sort((a, b) => a.order - b.order)
      .map(architectureAlignmentSource),
  );

  const lines: string[] = [];
  for (let index = 0; index <= document.lines.length; index += 1) {
    lines.push(...(insertions.get(index) ?? []));
    if (index === document.lines.length) break;
    const replacement = replacements.get(index);
    if (replacement) lines.push(...replacement);
    else if (!consumedLines.has(index)) lines.push(document.lines[index]);
  }
  return lines.join(document.newline);
}

function architectureModelsHaveSameSemantics(
  left: MermaidArchitectureModel,
  right: MermaidArchitectureModel,
) {
  const collection = (values: readonly { readonly order?: number }[]) =>
    [...values]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(architectureSemanticFingerprint);
  const idlessCollection = (values: readonly { id: string; order: number }[]) =>
    values.map(({ id: _id, order: _order, ...semantic }) =>
      JSON.stringify(semantic),
    );
  const comments = (model: MermaidArchitectureModel) => {
    const edgeIndex = new Map(
      model.edges.map((edge, index) => [edge.id, `edge:${index}`]),
    );
    const alignmentIndex = new Map(
      model.alignments.map((alignment, index) => [
        alignment.id,
        `alignment:${index}`,
      ]),
    );
    const groups = new Map<string, string[]>();
    for (const comment of model.comments ?? []) {
      const anchor =
        (comment.anchorKind === "edge"
          ? edgeIndex.get(comment.anchorId ?? "")
          : comment.anchorKind === "alignment"
            ? alignmentIndex.get(comment.anchorId ?? "")
            : comment.anchorId) ?? comment.anchorId;
      const key = JSON.stringify({
        anchor,
        anchorKind: comment.anchorKind,
        position: comment.position,
      });
      groups.set(key, [...(groups.get(key) ?? []), comment.line]);
    }
    return [...groups].sort(([leftKey], [rightKey]) =>
      leftKey.localeCompare(rightKey),
    );
  };
  return (
    left.accessibilityDescription === right.accessibilityDescription &&
    left.accessibilityTitle === right.accessibilityTitle &&
    left.diagramTitle === right.diagramTitle &&
    JSON.stringify(comments(left)) === JSON.stringify(comments(right)) &&
    JSON.stringify(left.directives) === JSON.stringify(right.directives) &&
    JSON.stringify(collection(left.groups)) ===
      JSON.stringify(collection(right.groups)) &&
    JSON.stringify(collection(left.services)) ===
      JSON.stringify(collection(right.services)) &&
    JSON.stringify(collection(left.junctions)) ===
      JSON.stringify(collection(right.junctions)) &&
    JSON.stringify(idlessCollection(left.edges)) ===
      JSON.stringify(idlessCollection(right.edges)) &&
    JSON.stringify(idlessCollection(left.alignments)) ===
      JSON.stringify(idlessCollection(right.alignments))
  );
}

export function generateArchitectureSourcePatch(
  model: MermaidArchitectureModel,
  document: MermaidArchitectureSourceDocument,
) {
  const candidate = createArchitectureSourcePatch(model, document);
  const reparsed = parseMermaidArchitectureSource(candidate);
  if (reparsed && architectureModelsHaveSameSemantics(model, reparsed)) {
    return candidate;
  }
  throw new Error(
    "Architecture writer could not preserve the ordered source document.",
  );
}
