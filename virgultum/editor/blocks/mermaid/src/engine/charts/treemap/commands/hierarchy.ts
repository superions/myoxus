// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  treemapDescendantIds,
  type TreemapModel,
  type TreemapNode,
} from "../model.js";
import { treemapRecordRangeWithEnding } from "../source-document.js";
import {
  applyTreemapPatches,
  treemapChildIndent,
  treemapNoChange,
  treemapPatchedOffset,
  treemapPatchedResult,
  type TreemapCommandResult,
  type TreemapPatch,
} from "../writer.js";

export type TreemapHierarchyCommand =
  | {
      readonly type: "hierarchy.reparent";
      readonly id: string;
      readonly parentId: string;
    }
  | {
      readonly type: "hierarchy.reorder";
      readonly id: string;
      readonly siblingId: string;
      readonly position: "before" | "after";
    };

function recordFor(model: TreemapModel, id: string) {
  return model.sourceDocument.records.find((record) => record.id === id);
}

function subtreeRecords(model: TreemapModel, node: TreemapNode) {
  const ids = new Set([node.id, ...treemapDescendantIds(model, node.id)]);
  const recordIds = new Set(
    model.nodes
      .filter((candidate) => ids.has(candidate.id))
      .map((candidate) => candidate.recordId),
  );
  for (const comment of model.comments) {
    if (comment.anchor.kind === "node" && ids.has(comment.anchor.id)) {
      recordIds.add(comment.recordId);
      const commentIndex = model.sourceDocument.records.findIndex(
        (record) => record.id === comment.recordId,
      );
      // Blank records separate a leading comment from the previous statement;
      // moving the comment without them would silently change its node anchor.
      for (let index = commentIndex - 1; index >= 0; index -= 1) {
        const record = model.sourceDocument.records[index];
        if (record.kind !== "blank") break;
        recordIds.add(record.id);
      }
    }
  }
  return model.sourceDocument.records
    .filter((record) => recordIds.has(record.id))
    .sort((left, right) => left.range.start - right.range.start);
}

function moveSubtree(
  model: TreemapModel,
  node: TreemapNode,
  insertionOffset: number,
  nextIndent: string,
): TreemapCommandResult {
  const records = subtreeRecords(model, node);
  const first = records[0];
  const last = records.at(-1);
  if (!first || !last) return treemapNoChange(model, "conflict");
  const range = {
    start: first.range.start,
    end: treemapRecordRangeWithEnding(model.sourceDocument, last).end,
  };
  if (insertionOffset >= range.start && insertionOffset <= range.end)
    return treemapNoChange(model, "descendant-target");
  const source = model.sourceDocument.source;
  const segments = records.map((record) => ({
    record,
    source: source.slice(
      record.range.start,
      treemapRecordRangeWithEnding(model.sourceDocument, record).end,
    ),
  }));
  const segmentStarts = new Map<number, number>();
  let segmentOffset = 0;
  for (const segment of segments) {
    segmentStarts.set(segment.record.range.start, segmentOffset);
    segmentOffset += segment.source.length;
  }
  const original = segments.map((segment) => segment.source).join("");
  const localPatches: TreemapPatch[] = records.flatMap((record) => {
    const semanticNode = model.nodes.find(
      (candidate) => candidate.recordId === record.id,
    );
    const boundComment = model.comments.find(
      (comment) =>
        comment.recordId === record.id && comment.anchor.kind === "node",
    );
    const boundNodeId =
      boundComment?.anchor.kind === "node" ? boundComment.anchor.id : undefined;
    const owner =
      semanticNode ??
      (boundNodeId
        ? model.nodes.find((candidate) => candidate.id === boundNodeId)
        : undefined);
    if (!owner) return [];
    const oldIndent = record.raw.match(/^[ \t]*/)?.[0] ?? "";
    const localStart = segmentStarts.get(record.range.start);
    if (localStart === undefined) return [];
    // Every subtree line keeps its relative indentation while the subtree root
    // adopts the target parent's existing indentation form.
    const replacement = nextIndent + oldIndent.slice(node.indent.length);
    return [
      {
        range: {
          start: localStart,
          end: localStart + oldIndent.length,
        },
        value: replacement,
      },
    ];
  });
  const moved = applyTreemapPatches(original, localPatches);
  if (moved === null) return treemapNoChange(model, "conflict");
  const withoutTrailingBreak = moved.replace(/(?:\r\n|\r|\n)$/, "");
  const removePatches = records.map((record) => ({
    range: treemapRecordRangeWithEnding(model.sourceDocument, record),
    value: "",
  }));
  const withoutOwnedRecords = applyTreemapPatches(source, removePatches);
  if (withoutOwnedRecords === null) return treemapNoChange(model, "conflict");
  const insertionAfterRemoval = treemapPatchedOffset(
    insertionOffset,
    removePatches,
  );
  // The target offset can point before a sibling or after a complete subtree.
  // Surround the moved block only where the adjacent source has no line break;
  // a fixed prefix either joins it to the next statement or creates blank lines.
  const prefix =
    insertionAfterRemoval > 0 &&
    !/[\r\n]/.test(withoutOwnedRecords[insertionAfterRemoval - 1] ?? "")
      ? model.sourceDocument.newline
      : "";
  const suffix =
    insertionAfterRemoval < withoutOwnedRecords.length &&
    !/[\r\n]/.test(withoutOwnedRecords[insertionAfterRemoval] ?? "")
      ? model.sourceDocument.newline
      : "";
  const insertPatch = {
    range: { start: insertionOffset, end: insertionOffset },
    value: prefix + withoutTrailingBreak + suffix,
  } as const;
  const relocated = new Map<number, string>();
  for (const record of records) {
    const relative = segmentStarts.get(record.range.start);
    if (relative === undefined) continue;
    relocated.set(
      insertionAfterRemoval +
        prefix.length +
        treemapPatchedOffset(relative, localPatches),
      record.id,
    );
  }
  return treemapPatchedResult(
    model,
    [...removePatches, insertPatch],
    { kind: "node", id: node.id },
    relocated,
  );
}

function subtreeEnd(model: TreemapModel, node: TreemapNode) {
  const records = subtreeRecords(model, node);
  return records.length
    ? treemapRecordRangeWithEnding(model.sourceDocument, records.at(-1)!).end
    : null;
}

export function applyTreemapHierarchyCommand(
  model: TreemapModel,
  command: TreemapHierarchyCommand,
) {
  const node = model.nodes.find((candidate) => candidate.id === command.id);
  if (!node) return treemapNoChange(model, "node-missing");
  if (command.type === "hierarchy.reparent") {
    const parent = model.nodes.find(
      (candidate) => candidate.id === command.parentId,
    );
    if (!parent || parent.value !== null || !parent.renderable)
      return treemapNoChange(model, "invalid-parent");
    if (
      node.id === parent.id ||
      treemapDescendantIds(model, node.id).has(parent.id)
    )
      return treemapNoChange(model, "descendant-target");
    if (node.parentId === parent.id) return treemapNoChange(model, "no-change");
    if (node.parentId === null && model.roots.length === 1)
      return treemapNoChange(model, "root-move-forbidden");
    const indent = treemapChildIndent(model, parent.id);
    const offset = subtreeEnd(model, parent);
    if (indent === null || offset === null)
      return treemapNoChange(model, "conflict");
    return moveSubtree(model, node, offset, indent);
  }
  const sibling = model.nodes.find(
    (candidate) => candidate.id === command.siblingId,
  );
  if (!sibling || sibling.id === node.id || sibling.parentId !== node.parentId)
    return treemapNoChange(model, "invalid-sibling");
  const siblingRecord = recordFor(model, sibling.recordId);
  const offset =
    command.position === "before"
      ? subtreeRecords(model, sibling)[0]?.range.start
      : subtreeEnd(model, sibling);
  if (!siblingRecord || offset === undefined || offset === null)
    return treemapNoChange(model, "conflict");
  return moveSubtree(model, node, offset, node.indent);
}
