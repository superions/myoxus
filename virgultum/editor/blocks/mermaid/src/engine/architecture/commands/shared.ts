// SPDX-License-Identifier: AGPL-3.0-or-later

import { ARCHITECTURE_ID } from "../grammar.js";
import type { MermaidArchitectureModel } from "../model.js";

export type MermaidArchitectureCommandSelection = {
  readonly id?: string;
  readonly kind:
    | "alignment"
    | "comment"
    | "diagram"
    | "edge"
    | "group"
    | "junction"
    | "metadata"
    | "service";
};

export type MermaidArchitectureCommandFocus =
  "canvas" | "comment" | "edge-label" | "service-label";

export type MermaidArchitectureCommandDiagnosis = {
  readonly code: string;
};

export type MermaidArchitectureCommandImpact = {
  readonly removedAlignmentIds?: readonly string[];
  readonly removedCommentIds?: readonly string[];
  readonly removedEdgeIds?: readonly string[];
  readonly removedObjectIds?: readonly string[];
  readonly reparentedObjectIds?: readonly string[];
};

export type MermaidArchitectureCommandResult = {
  readonly changed: boolean;
  readonly diagnosis?: MermaidArchitectureCommandDiagnosis;
  readonly focusAfter: MermaidArchitectureCommandFocus;
  readonly impact?: MermaidArchitectureCommandImpact;
  readonly model: MermaidArchitectureModel;
  readonly selectionAfter: MermaidArchitectureCommandSelection;
};

export function cloneArchitectureModel(model: MermaidArchitectureModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidArchitectureModel;
}

const ARCHITECTURE_ID_RE = new RegExp(`^${ARCHITECTURE_ID}$`);

export function architectureObjectIds(model: MermaidArchitectureModel) {
  return new Set([
    ...model.groups.map(({ id }) => id),
    ...model.junctions.map(({ id }) => id),
    ...model.services.map(({ id }) => id),
  ]);
}

export function nextArchitectureObjectId(
  model: MermaidArchitectureModel,
  prefix: "group" | "junction" | "service",
) {
  const ids = architectureObjectIds(model);
  let index = ids.size + 1;
  while (ids.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

export function validArchitectureObjectId(
  model: MermaidArchitectureModel,
  previousId: string,
  nextId: string,
) {
  return (
    ARCHITECTURE_ID_RE.test(nextId) &&
    (nextId === previousId || !architectureObjectIds(model).has(nextId))
  );
}

export function architectureGroupParentIsValid(
  model: MermaidArchitectureModel,
  groupId: string,
  parentId: string,
) {
  if (!parentId) return true;
  const groups = new Map(model.groups.map((group) => [group.id, group]));
  if (!groups.has(parentId) || parentId === groupId) return false;
  const visited = new Set([groupId]);
  let currentId = parentId;
  while (currentId) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = groups.get(currentId)?.parentId ?? "";
  }
  return true;
}

export function updateArchitectureObjectReferences(
  model: MermaidArchitectureModel,
  previousId: string,
  nextId: string,
) {
  for (const record of model.sourceDocument?.records ?? []) {
    if (
      record.kind === "statement" &&
      (record.statementKind === "group" ||
        record.statementKind === "junction" ||
        record.statementKind === "service") &&
      record.id === previousId
    ) {
      record.id = nextId;
    }
  }
  for (const group of model.groups) {
    if (group.parentId === previousId) group.parentId = nextId;
  }
  for (const service of model.services) {
    if (service.groupId === previousId) service.groupId = nextId;
  }
  for (const junction of model.junctions) {
    if (junction.groupId === previousId) junction.groupId = nextId;
  }
  for (const edge of model.edges) {
    if (edge.from === previousId) edge.from = nextId;
    if (edge.to === previousId) edge.to = nextId;
  }
  for (const alignment of model.alignments) {
    alignment.members = alignment.members.map((member) =>
      member === previousId ? nextId : member,
    );
  }
  for (const comment of model.comments ?? []) {
    if (comment.anchorId === previousId) comment.anchorId = nextId;
  }
}

export function architectureNodeGroupId(
  model: MermaidArchitectureModel,
  nodeId: string,
) {
  return (
    model.services.find(({ id }) => id === nodeId)?.groupId ??
    model.junctions.find(({ id }) => id === nodeId)?.groupId ??
    ""
  );
}

export function normalizeArchitectureEdgeGroupMarkers(
  model: MermaidArchitectureModel,
) {
  for (const edge of model.edges) {
    const fromGroupId = architectureNodeGroupId(model, edge.from);
    const toGroupId = architectureNodeGroupId(model, edge.to);
    if (fromGroupId && fromGroupId === toGroupId) {
      edge.fromGroup = false;
      edge.toGroup = false;
    }
  }
}

export function refreshArchitectureSourceAnnotations(
  model: MermaidArchitectureModel,
) {
  model.sourceAnnotations = (model.comments ?? []).map(
    (comment) => comment.line,
  );
}

export function architectureCommandResult(
  model: MermaidArchitectureModel,
  changed: boolean,
  selectionAfter: MermaidArchitectureCommandSelection,
  focusAfter: MermaidArchitectureCommandFocus,
  diagnosis?: MermaidArchitectureCommandDiagnosis,
  impact?: MermaidArchitectureCommandImpact,
): MermaidArchitectureCommandResult {
  return {
    changed,
    diagnosis,
    focusAfter,
    impact,
    model,
    selectionAfter,
  };
}

export function unchangedArchitectureCommand(
  model: MermaidArchitectureModel,
  selectionAfter: MermaidArchitectureCommandSelection,
  focusAfter: MermaidArchitectureCommandFocus,
  code: string,
) {
  return architectureCommandResult(model, false, selectionAfter, focusAfter, {
    code,
  });
}
