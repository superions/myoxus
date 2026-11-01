// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  treemapChildren,
  treemapDescendantIds,
  type TreemapModel,
} from "../model.js";
import { treemapRecordRangeWithEnding } from "../source-document.js";
import {
  encodeTreemapLabel,
  encodeTreemapValue,
  treemapChildIndent,
  treemapInsertionOffset,
  treemapNoChange,
  treemapPatchedResult,
  type TreemapCommandResult,
  type TreemapPatch,
} from "../writer.js";

export type TreemapNodeCommand =
  | {
      readonly type: "node.add";
      readonly parentId: string | null;
      readonly nodeType: "section" | "leaf";
      readonly label: string;
      readonly value?: number;
    }
  | {
      readonly type: "node.rename";
      readonly id: string;
      readonly label: string;
    }
  | {
      readonly type: "node.repair-record";
      readonly recordId: string;
      readonly recordStart?: number;
      readonly recordRaw?: string;
      readonly nodeType: "section" | "leaf";
      readonly label: string;
      readonly value?: number;
    }
  | {
      readonly type: "node.delete-record";
      readonly recordId: string;
      readonly recordStart?: number;
      readonly recordRaw?: string;
      readonly confirmed?: boolean;
    }
  | {
      readonly type: "node.convert-to-section";
      readonly id: string;
      readonly childLabel: string;
    }
  | {
      readonly type: "node.convert-to-leaf";
      readonly id: string;
      readonly value: number;
    }
  | {
      readonly type: "node.delete";
      readonly id: string;
      readonly strategy?: "subtree" | "promote";
      readonly confirmed?: boolean;
    };

function recordFor(model: TreemapModel, recordId: string) {
  return model.sourceDocument.records.find((record) => record.id === recordId);
}

function malformedRecordFor(
  model: TreemapModel,
  command: Extract<
    TreemapNodeCommand,
    { type: "node.repair-record" | "node.delete-record" }
  >,
) {
  const byId = recordFor(model, command.recordId);
  if (byId) return byId;
  if (command.recordStart === undefined || command.recordRaw === undefined)
    return undefined;
  // Malformed statements have no semantic node ID. Accept a rescanned record
  // only when its immutable source anchor still identifies exactly one line.
  const matches = model.sourceDocument.records.filter(
    (record) =>
      record.kind === "node" &&
      record.range.start === command.recordStart &&
      record.raw === command.recordRaw,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function boundComments(model: TreemapModel, nodeId: string) {
  return model.comments
    .filter(
      (comment) =>
        comment.anchor.kind === "node" && comment.anchor.id === nodeId,
    )
    .map((comment) => recordFor(model, comment.recordId))
    .filter((record): record is NonNullable<typeof record> => Boolean(record));
}

function selectedNewRecord(result: TreemapCommandResult, recordId: string) {
  const node = result.model.nodes.find(
    (candidate) => candidate.recordId === recordId,
  );
  return node
    ? { ...result, selection: { kind: "node" as const, id: node.id } }
    : result;
}

export function applyTreemapNodeCommand(
  model: TreemapModel,
  command: TreemapNodeCommand,
): TreemapCommandResult {
  if (
    command.type === "node.repair-record" ||
    command.type === "node.delete-record"
  ) {
    const record = malformedRecordFor(model, command);
    const alreadyParsed = model.nodes.some(
      (candidate) => candidate.recordId === record?.id,
    );
    if (!record || record.kind !== "node" || alreadyParsed)
      return treemapNoChange(model, "record-missing");
    if (command.type === "node.delete-record") {
      if (!command.confirmed)
        return treemapNoChange(model, "confirmation-required");
      return treemapPatchedResult(
        model,
        [
          {
            range: treemapRecordRangeWithEnding(model.sourceDocument, record),
            value: "",
          },
        ],
        null,
      );
    }
    const label = encodeTreemapLabel(command.label);
    const value =
      command.nodeType === "leaf"
        ? encodeTreemapValue(command.value ?? Number.NaN)
        : null;
    if (!label) return treemapNoChange(model, "invalid-label");
    if (command.nodeType === "leaf" && value === null)
      return treemapNoChange(model, "invalid-number");
    const indent = record.raw.match(/^[ \t]*/)?.[0] ?? "";
    const result = treemapPatchedResult(
      model,
      [
        {
          range: record.range,
          value: `${indent}${label}${value === null ? "" : `: ${value}`}`,
        },
      ],
      null,
      new Map([[record.range.start, record.id]]),
    );
    return selectedNewRecord(result, record.id);
  }

  if (command.type === "node.add") {
    if (command.parentId === null && model.roots.length > 0)
      return treemapNoChange(model, "multiple-roots");
    const parent = command.parentId
      ? model.nodes.find((node) => node.id === command.parentId)
      : undefined;
    if (
      command.parentId &&
      (!parent || parent.value !== null || !parent.renderable)
    )
      return treemapNoChange(model, "leaf-parent");
    const label = encodeTreemapLabel(command.label);
    const value =
      command.nodeType === "leaf"
        ? encodeTreemapValue(command.value ?? Number.NaN)
        : null;
    if (!label) return treemapNoChange(model, "invalid-label");
    if (command.nodeType === "leaf" && value === null)
      return treemapNoChange(model, "invalid-number");
    const indent = parent ? treemapChildIndent(model, parent.id) : "";
    if (indent === null) return treemapNoChange(model, "parent-missing");
    const line = `${indent}${label}${value === null ? "" : `: ${value}`}`;
    const offset = treemapInsertionOffset(model, parent?.id);
    const newline = model.sourceDocument.newline;
    const recordId = crypto.randomUUID();
    const result = treemapPatchedResult(
      model,
      [{ range: { start: offset, end: offset }, value: `${newline}${line}` }],
      null,
      new Map([[offset + newline.length, recordId]]),
    );
    return selectedNewRecord(result, recordId);
  }

  const node = model.nodes.find((candidate) => candidate.id === command.id);
  if (!node) return treemapNoChange(model, "node-missing");
  const record = recordFor(model, node.recordId);
  if (!record) return treemapNoChange(model, "conflict");

  if (command.type === "node.rename") {
    const label = encodeTreemapLabel(command.label, node.labelQuote);
    if (!label) return treemapNoChange(model, "invalid-label");
    return treemapPatchedResult(
      model,
      [
        {
          range: {
            start: node.labelRange.start - 1,
            end: node.labelRange.end + 1,
          },
          value: label,
        },
      ],
      { kind: "node", id: node.id },
    );
  }

  if (command.type === "node.convert-to-section") {
    if (node.value === null) return treemapNoChange(model, "no-change");
    const childLabel = encodeTreemapLabel(command.childLabel);
    // Conversion transfers the authored value lexeme verbatim. Commas and
    // other Mermaid-compatible number spelling are content, not formatting.
    const childValue = node.valueLexeme ?? encodeTreemapValue(node.value);
    const indent = treemapChildIndent(
      {
        ...model,
        nodes: model.nodes.map((candidate) =>
          candidate.id === node.id ? { ...candidate, value: null } : candidate,
        ),
      },
      node.id,
    );
    if (!childLabel || childValue === null || indent === null)
      return treemapNoChange(model, "invalid-conversion");
    const suffixStart = node.separatorRange?.start ?? record.range.end;
    const classSuffix = node.classRange
      ? `:::${model.sourceDocument.source.slice(node.classRange.start, node.classRange.end)}`
      : "";
    const newline = model.sourceDocument.newline;
    const result = treemapPatchedResult(
      model,
      [
        {
          range: { start: suffixStart, end: record.range.end },
          value: classSuffix,
        },
        {
          range: { start: record.range.end, end: record.range.end },
          value: `${newline}${indent}${childLabel}: ${childValue}`,
        },
      ],
      { kind: "node", id: node.id },
    );
    return result;
  }

  if (command.type === "node.convert-to-leaf") {
    if (node.value !== null) return treemapNoChange(model, "no-change");
    if (treemapChildren(model, node.id).length)
      return treemapNoChange(model, "section-not-empty");
    const value = encodeTreemapValue(command.value);
    if (value === null) return treemapNoChange(model, "invalid-number");
    const insert = node.classRange
      ? node.classRange.start - 3
      : record.range.end;
    return treemapPatchedResult(
      model,
      [{ range: { start: insert, end: insert }, value: `: ${value}` }],
      { kind: "node", id: node.id },
    );
  }

  const descendants = treemapDescendantIds(model, node.id);
  const comments = boundComments(model, node.id);
  if ((descendants.size > 0 || comments.length > 0) && !command.confirmed)
    return treemapNoChange(model, "confirmation-required");
  if (command.strategy === "promote") {
    const children = treemapChildren(model, node.id);
    if (node.parentId === null && children.length !== 1)
      return treemapNoChange(model, "promote-invalid-root");
    const delta = children[0]?.indent.length - node.indent.length;
    if (!delta || delta < 1) return treemapNoChange(model, "promote-invalid");
    const patches: TreemapPatch[] = children.flatMap((child) => {
      const ids = new Set([child.id, ...treemapDescendantIds(model, child.id)]);
      const nodePatches = model.nodes
        .filter((candidate) => ids.has(candidate.id))
        .map((candidate) => ({
          range: candidate.indentRange,
          value: candidate.indent.slice(
            Math.min(delta, candidate.indent.length),
          ),
        }));
      const commentPatches = model.comments.flatMap((comment) => {
        if (comment.anchor.kind !== "node" || !ids.has(comment.anchor.id))
          return [];
        const commentRecord = recordFor(model, comment.recordId);
        if (!commentRecord) return [];
        const indent = commentRecord.raw.match(/^[ \t]*/)?.[0] ?? "";
        return [
          {
            range: {
              start: commentRecord.range.start,
              end: commentRecord.range.start + indent.length,
            },
            value: indent.slice(Math.min(delta, indent.length)),
          },
        ];
      });
      return [...nodePatches, ...commentPatches];
    });
    const range = treemapRecordRangeWithEnding(model.sourceDocument, record);
    const firstComment = comments.sort(
      (left, right) => left.range.start - right.range.start,
    )[0];
    const result = treemapPatchedResult(
      model,
      [
        ...patches,
        {
          range: {
            start: firstComment?.range.start ?? range.start,
            end: range.end,
          },
          value: "",
        },
      ],
      null,
    );
    const promoted = result.model.nodes.find(
      (candidate) => candidate.id === children[0]?.id,
    );
    return promoted
      ? { ...result, selection: { kind: "node", id: promoted.id } }
      : result;
  }
  const removed = new Set([node.id, ...descendants]);
  const records = model.nodes
    .filter((candidate) => removed.has(candidate.id))
    .map((candidate) => recordFor(model, candidate.recordId))
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate),
    );
  const allComments = model.comments
    .filter(
      (comment) =>
        comment.anchor.kind === "node" && removed.has(comment.anchor.id),
    )
    .map((comment) => recordFor(model, comment.recordId))
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate),
    );
  const ownedRecords = [...records, ...allComments].filter(
    (candidate, index, all) =>
      all.findIndex((record) => record.id === candidate.id) === index,
  );
  const result = treemapPatchedResult(
    model,
    ownedRecords.map((candidate) => ({
      range: treemapRecordRangeWithEnding(model.sourceDocument, candidate),
      value: "",
    })),
    null,
  );
  const fallback = result.model.nodes.find(
    (candidate) => candidate.id === node.parentId,
  );
  return fallback
    ? { ...result, selection: { kind: "node", id: fallback.id } }
    : result;
}

export function treemapDeleteImpact(model: TreemapModel, nodeId: string) {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  const descendants = treemapDescendantIds(model, nodeId);
  const subtree = model.nodes.filter(
    (candidate) => candidate.id === nodeId || descendants.has(candidate.id),
  );
  return {
    node,
    directChildren: treemapChildren(model, nodeId).length,
    subtreeSize: subtree.length,
    leaves: subtree.filter((candidate) => candidate.value !== null).length,
    value: subtree
      .filter((candidate) => candidate.value !== null)
      .reduce((sum, candidate) => sum + Math.max(0, candidate.value ?? 0), 0),
    comments: model.comments.filter(
      (comment) =>
        comment.anchor.kind === "node" &&
        (comment.anchor.id === nodeId || descendants.has(comment.anchor.id)),
    ).length,
    classes: new Set(
      subtree.map((candidate) => candidate.className).filter(Boolean),
    ).size,
  };
}
