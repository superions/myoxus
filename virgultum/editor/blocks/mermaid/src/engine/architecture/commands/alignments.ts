// SPDX-License-Identifier: AGPL-3.0-or-later

import { architectureStableStatementId } from "../grammar.js";
import type { MermaidArchitectureModel } from "../model.js";
import {
  architectureCommandResult,
  cloneArchitectureModel,
  refreshArchitectureSourceAnnotations,
  unchangedArchitectureCommand,
} from "./shared.js";

function validateArchitectureAlignment(
  model: MermaidArchitectureModel,
  members: readonly string[],
  direction: "column" | "row",
  alignmentId?: string,
) {
  const uniqueMembers = [...new Set(members)];
  const nodeIds = new Set([
    ...model.services.map(({ id }) => id),
    ...model.junctions.map(({ id }) => id),
  ]);
  if (
    uniqueMembers.length !== members.length ||
    uniqueMembers.length < 2 ||
    uniqueMembers.some((member) => !nodeIds.has(member))
  ) {
    return "architecture.alignment-members-invalid";
  }
  if (
    model.alignments.some(
      (alignment) =>
        alignment.id !== alignmentId &&
        alignment.direction === direction &&
        alignment.members.some((member) => uniqueMembers.includes(member)),
    )
  ) {
    return "architecture.alignment-conflict";
  }
  return null;
}

export function setMermaidArchitectureAlignment(
  model: MermaidArchitectureModel,
  members: readonly string[],
  direction: "column" | "row",
) {
  const uniqueMembers = [...new Set(members)];
  const existing = model.alignments.find(
    (alignment) =>
      alignment.direction === direction &&
      alignment.members.length === uniqueMembers.length &&
      alignment.members.every((member) => uniqueMembers.includes(member)),
  );
  const diagnosis = validateArchitectureAlignment(
    model,
    members,
    direction,
    existing?.id,
  );
  if (diagnosis) {
    return unchangedArchitectureCommand(
      model,
      existing ? { id: existing.id, kind: "alignment" } : { kind: "diagram" },
      "canvas",
      diagnosis,
    );
  }
  const next = cloneArchitectureModel(model);
  const target = existing
    ? next.alignments.find(({ id }) => id === existing.id)!
    : undefined;
  if (target) {
    target.direction = direction;
    target.members = [...members];
  } else {
    const ids = new Set(next.alignments.map(({ id }) => id));
    const semanticKey = `${direction}\n${members.join("\n")}`;
    let occurrence =
      next.alignments.filter(
        (alignment) =>
          alignment.direction === direction &&
          alignment.members.length === members.length &&
          alignment.members.every((member, index) => member === members[index]),
      ).length + 1;
    let id = architectureStableStatementId(
      "alignment",
      semanticKey,
      occurrence,
    );
    while (ids.has(id)) {
      occurrence += 1;
      id = architectureStableStatementId("alignment", semanticKey, occurrence);
    }
    next.alignments.push({
      direction,
      id,
      members: [...members],
      order: next.alignments.length,
    });
  }
  const alignment = target ?? next.alignments.at(-1)!;
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(
        next,
        true,
        { id: alignment.id, kind: "alignment" },
        "canvas",
      )
    : unchangedArchitectureCommand(
        model,
        { id: alignment.id, kind: "alignment" },
        "canvas",
        "architecture.no-change",
      );
}

export function updateMermaidArchitectureAlignment(
  model: MermaidArchitectureModel,
  alignmentId: string,
  members: readonly string[],
  direction: "column" | "row",
) {
  const alignment = model.alignments.find(({ id }) => id === alignmentId);
  if (!alignment) {
    return unchangedArchitectureCommand(
      model,
      { kind: "diagram" },
      "canvas",
      "architecture.alignment-not-found",
    );
  }
  const diagnosis = validateArchitectureAlignment(
    model,
    members,
    direction,
    alignmentId,
  );
  if (diagnosis) {
    return unchangedArchitectureCommand(
      model,
      { id: alignmentId, kind: "alignment" },
      "canvas",
      diagnosis,
    );
  }
  const next = cloneArchitectureModel(model);
  Object.assign(
    next.alignments.find(({ id }) => id === alignmentId)!,
    { direction, members: [...members] },
  );
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(
        next,
        true,
        { id: alignmentId, kind: "alignment" },
        "canvas",
      )
    : unchangedArchitectureCommand(
        model,
        { id: alignmentId, kind: "alignment" },
        "canvas",
        "architecture.no-change",
      );
}

export function deleteMermaidArchitectureAlignment(
  model: MermaidArchitectureModel,
  alignmentId: string,
) {
  if (!model.alignments.some(({ id }) => id === alignmentId)) {
    return unchangedArchitectureCommand(
      model,
      { kind: "diagram" },
      "canvas",
      "architecture.alignment-not-found",
    );
  }
  const next = cloneArchitectureModel(model);
  const removedCommentIds = (next.comments ?? [])
    .filter(
      (comment) =>
        comment.anchorKind === "alignment" && comment.anchorId === alignmentId,
    )
    .map(({ id }) => id);
  const removedCommentIdSet = new Set(removedCommentIds);
  next.alignments = next.alignments.filter(({ id }) => id !== alignmentId);
  next.comments = (next.comments ?? []).filter(
    (comment) => !removedCommentIdSet.has(comment.id),
  );
  refreshArchitectureSourceAnnotations(next);
  return architectureCommandResult(
    next,
    true,
    { kind: "diagram" },
    "canvas",
    undefined,
    { removedAlignmentIds: [alignmentId], removedCommentIds },
  );
}
