// SPDX-License-Identifier: AGPL-3.0-or-later

import { ARCHITECTURE_ICON_VALUE_RE } from "../grammar.js";
import type {
  MermaidArchitectureGroup,
  MermaidArchitectureJunction,
  MermaidArchitectureModel,
  MermaidArchitectureService,
} from "../model.js";
import {
  architectureCommandResult,
  architectureGroupParentIsValid,
  cloneArchitectureModel,
  nextArchitectureObjectId,
  normalizeArchitectureEdgeGroupMarkers,
  refreshArchitectureSourceAnnotations,
  unchangedArchitectureCommand,
  updateArchitectureObjectReferences,
  validArchitectureObjectId,
  type MermaidArchitectureCommandFocus,
} from "./shared.js";

type ArchitectureServicePatch = Partial<
  Pick<
    MermaidArchitectureService,
    "groupId" | "hasIcon" | "hasLabel" | "icon" | "iconKind" | "id" | "label"
  >
>;

type ArchitectureJunctionPatch = Partial<
  Pick<MermaidArchitectureJunction, "groupId" | "id">
>;

type ArchitectureGroupPatch = Partial<
  Pick<
    MermaidArchitectureGroup,
    "hasIcon" | "hasLabel" | "icon" | "id" | "label" | "parentId"
  >
>;

function architectureServiceIconIsValid(
  iconKind: MermaidArchitectureService["iconKind"],
  icon: string,
  hasIcon: boolean,
) {
  return (
    ["icon", "none", "text"].includes(iconKind) &&
    (!hasIcon || Boolean(icon)) &&
    (!hasIcon || iconKind !== "icon" || ARCHITECTURE_ICON_VALUE_RE.test(icon))
  );
}

function architectureGroupIconIsValid(icon: string, hasIcon: boolean) {
  return !hasIcon || (Boolean(icon) && ARCHITECTURE_ICON_VALUE_RE.test(icon));
}

export function addMermaidArchitectureService(
  model: MermaidArchitectureModel,
  patch: ArchitectureServicePatch = {},
) {
  const id = patch.id?.trim() || nextArchitectureObjectId(model, "service");
  const selection = { kind: "diagram" } as const;
  if (!validArchitectureObjectId(model, "", id)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.id-invalid-or-duplicate",
    );
  }
  const groupId = patch.groupId ?? "";
  if (groupId && !model.groups.some(({ id }) => id === groupId)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.parent-not-found",
    );
  }
  const iconKind = patch.iconKind ?? "none";
  const icon = patch.icon ?? "";
  const hasIcon =
    iconKind === "none" ? false : (patch.hasIcon ?? Boolean(icon));
  if (!architectureServiceIconIsValid(iconKind, icon, hasIcon)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.icon-invalid",
    );
  }
  const next = cloneArchitectureModel(model);
  next.services.push({
    groupId,
    hasIcon,
    hasLabel: patch.hasLabel ?? false,
    icon,
    iconKind,
    id,
    label: patch.label ?? "",
    order: next.services.length,
  });
  return architectureCommandResult(
    next,
    true,
    { id, kind: "service" },
    "canvas",
  );
}

export function addMermaidArchitectureJunction(
  model: MermaidArchitectureModel,
  patch: ArchitectureJunctionPatch = {},
) {
  const id = patch.id?.trim() || nextArchitectureObjectId(model, "junction");
  const selection = { kind: "diagram" } as const;
  if (!validArchitectureObjectId(model, "", id)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.id-invalid-or-duplicate",
    );
  }
  const groupId = patch.groupId ?? "";
  if (groupId && !model.groups.some(({ id }) => id === groupId)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.parent-not-found",
    );
  }
  const next = cloneArchitectureModel(model);
  next.junctions.push({ groupId, id, order: next.junctions.length });
  return architectureCommandResult(
    next,
    true,
    { id, kind: "junction" },
    "canvas",
  );
}

export function addMermaidArchitectureGroup(
  model: MermaidArchitectureModel,
  patch: ArchitectureGroupPatch = {},
  memberIds: readonly string[] = [],
) {
  const id = patch.id?.trim() || nextArchitectureObjectId(model, "group");
  const selection = { kind: "diagram" } as const;
  if (!validArchitectureObjectId(model, "", id)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.id-invalid-or-duplicate",
    );
  }
  const nodeParentById = new Map([
    ...model.services.map(({ groupId, id }) => [id, groupId] as const),
    ...model.junctions.map(({ groupId, id }) => [id, groupId] as const),
  ]);
  if (memberIds.some((memberId) => !nodeParentById.has(memberId))) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.group-members-invalid",
    );
  }
  const memberParents = new Set(
    memberIds.map((memberId) => nodeParentById.get(memberId) ?? ""),
  );
  const commonMemberParent =
    memberParents.size === 1 ? ([...memberParents][0] ?? "") : "";
  const parentId = patch.parentId ?? commonMemberParent;
  if (
    memberParents.size > 1 ||
    (memberIds.length > 0 && parentId !== commonMemberParent) ||
    !architectureGroupParentIsValid(model, id, parentId)
  ) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.parent-invalid",
    );
  }
  const icon = patch.icon ?? "";
  const hasIcon = patch.hasIcon ?? Boolean(icon);
  if (!architectureGroupIconIsValid(icon, hasIcon)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.icon-invalid",
    );
  }
  const next = cloneArchitectureModel(model);
  next.groups.push({
    hasIcon,
    hasLabel: patch.hasLabel ?? false,
    icon,
    id,
    label: patch.label ?? "",
    order: next.groups.length,
    parentId,
  });
  const members = new Set(memberIds);
  for (const service of next.services) {
    if (members.has(service.id)) service.groupId = id;
  }
  for (const junction of next.junctions) {
    if (members.has(junction.id)) junction.groupId = id;
  }
  normalizeArchitectureEdgeGroupMarkers(next);
  return architectureCommandResult(next, true, { id, kind: "group" }, "canvas");
}

export function renameMermaidArchitectureService(
  model: MermaidArchitectureModel,
  serviceId: string,
  label: string,
) {
  const service = model.services.find(({ id }) => id === serviceId);
  return updateMermaidArchitectureService(
    model,
    serviceId,
    { hasLabel: true, label: label.trim() || service?.id || serviceId },
    "service-label",
  );
}

export function updateMermaidArchitectureService(
  model: MermaidArchitectureModel,
  serviceId: string,
  patch: ArchitectureServicePatch,
  focusAfter: MermaidArchitectureCommandFocus = "canvas",
) {
  const selection = { id: serviceId, kind: "service" } as const;
  const service = model.services.find(
    (candidate) => candidate.id === serviceId,
  );
  if (!service) {
    return unchangedArchitectureCommand(
      model,
      selection,
      focusAfter,
      "architecture.service-not-found",
    );
  }
  const nextId = patch.id?.trim() ?? service.id;
  if (!validArchitectureObjectId(model, service.id, nextId)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      focusAfter,
      "architecture.id-invalid-or-duplicate",
    );
  }
  const nextGroupId = patch.groupId ?? service.groupId;
  if (
    nextGroupId &&
    !model.groups.some((candidate) => candidate.id === nextGroupId)
  ) {
    return unchangedArchitectureCommand(
      model,
      selection,
      focusAfter,
      "architecture.parent-not-found",
    );
  }
  const nextIconKind = patch.iconKind ?? service.iconKind;
  const nextIcon = patch.icon ?? service.icon;
  const nextHasIcon =
    nextIconKind === "none" ? false : (patch.hasIcon ?? service.hasIcon);
  if (!architectureServiceIconIsValid(nextIconKind, nextIcon, nextHasIcon)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      focusAfter,
      "architecture.icon-invalid",
    );
  }
  const next = cloneArchitectureModel(model);
  const target = next.services.find((candidate) => candidate.id === serviceId)!;
  Object.assign(target, patch, {
    groupId: nextGroupId,
    hasIcon: nextHasIcon,
    icon: nextIcon,
    iconKind: nextIconKind,
    id: nextId,
  });
  if (nextId !== serviceId) {
    updateArchitectureObjectReferences(next, serviceId, nextId);
  }
  if (nextGroupId !== service.groupId) {
    normalizeArchitectureEdgeGroupMarkers(next);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(
        next,
        true,
        { id: nextId, kind: "service" },
        focusAfter,
      )
    : unchangedArchitectureCommand(
        model,
        selection,
        focusAfter,
        "architecture.no-change",
      );
}

export function updateMermaidArchitectureJunction(
  model: MermaidArchitectureModel,
  junctionId: string,
  patch: ArchitectureJunctionPatch,
) {
  const selection = { id: junctionId, kind: "junction" } as const;
  const junction = model.junctions.find(
    (candidate) => candidate.id === junctionId,
  );
  if (!junction) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.junction-not-found",
    );
  }
  const nextId = patch.id?.trim() ?? junction.id;
  if (!validArchitectureObjectId(model, junction.id, nextId)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.id-invalid-or-duplicate",
    );
  }
  const nextGroupId = patch.groupId ?? junction.groupId;
  if (
    nextGroupId &&
    !model.groups.some((candidate) => candidate.id === nextGroupId)
  ) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.parent-not-found",
    );
  }
  const next = cloneArchitectureModel(model);
  const target = next.junctions.find(
    (candidate) => candidate.id === junctionId,
  )!;
  Object.assign(target, patch, { groupId: nextGroupId, id: nextId });
  if (nextId !== junctionId) {
    updateArchitectureObjectReferences(next, junctionId, nextId);
  }
  if (nextGroupId !== junction.groupId) {
    normalizeArchitectureEdgeGroupMarkers(next);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(
        next,
        true,
        { id: nextId, kind: "junction" },
        "canvas",
      )
    : unchangedArchitectureCommand(
        model,
        selection,
        "canvas",
        "architecture.no-change",
      );
}

export function convertMermaidArchitectureNode(
  model: MermaidArchitectureModel,
  nodeId: string,
  kind: "junction" | "service",
) {
  const service = model.services.find((candidate) => candidate.id === nodeId);
  const junction = model.junctions.find((candidate) => candidate.id === nodeId);
  const currentKind = service ? "service" : junction ? "junction" : null;
  const selection = { id: nodeId, kind: currentKind ?? kind } as const;
  if (!currentKind) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.node-not-found",
    );
  }
  if (currentKind === kind) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.no-change",
    );
  }
  const next = cloneArchitectureModel(model);
  if (kind === "junction") {
    const target = next.services.find((candidate) => candidate.id === nodeId)!;
    next.services = next.services.filter(
      (candidate) => candidate.id !== nodeId,
    );
    next.junctions.push({
      groupId: target.groupId,
      id: target.id,
      order: target.order,
    });
  } else {
    const target = next.junctions.find((candidate) => candidate.id === nodeId)!;
    next.junctions = next.junctions.filter(
      (candidate) => candidate.id !== nodeId,
    );
    next.services.push({
      groupId: target.groupId,
      hasIcon: false,
      hasLabel: false,
      icon: "",
      iconKind: "none",
      id: target.id,
      label: "",
      order: target.order,
    });
  }
  for (const comment of next.comments ?? []) {
    if (
      comment.anchorId === nodeId &&
      (comment.anchorKind === "junction" || comment.anchorKind === "service")
    ) {
      comment.anchorKind = kind;
    }
  }
  return architectureCommandResult(next, true, { id: nodeId, kind }, "canvas");
}

export function updateMermaidArchitectureGroup(
  model: MermaidArchitectureModel,
  groupId: string,
  patch: ArchitectureGroupPatch,
) {
  const selection = { id: groupId, kind: "group" } as const;
  const group = model.groups.find((candidate) => candidate.id === groupId);
  if (!group) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.group-not-found",
    );
  }
  const nextId = patch.id?.trim() ?? group.id;
  if (!validArchitectureObjectId(model, group.id, nextId)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.id-invalid-or-duplicate",
    );
  }
  const nextParentId = patch.parentId ?? group.parentId;
  if (
    nextParentId === nextId ||
    !architectureGroupParentIsValid(model, group.id, nextParentId)
  ) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.parent-invalid",
    );
  }
  const nextIcon = patch.icon ?? group.icon;
  const nextHasIcon = patch.hasIcon ?? group.hasIcon;
  if (!architectureGroupIconIsValid(nextIcon, nextHasIcon)) {
    return unchangedArchitectureCommand(
      model,
      selection,
      "canvas",
      "architecture.icon-invalid",
    );
  }
  const next = cloneArchitectureModel(model);
  const target = next.groups.find((candidate) => candidate.id === groupId)!;
  Object.assign(target, patch, {
    hasIcon: nextHasIcon,
    icon: nextIcon,
    id: nextId,
    parentId: nextParentId,
  });
  if (nextId !== groupId) {
    updateArchitectureObjectReferences(next, groupId, nextId);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(
        next,
        true,
        { id: nextId, kind: "group" },
        "canvas",
      )
    : unchangedArchitectureCommand(
        model,
        selection,
        "canvas",
        "architecture.no-change",
      );
}

function deleteMermaidArchitectureNode(
  model: MermaidArchitectureModel,
  nodeId: string,
  kind: "junction" | "service",
) {
  const exists =
    kind === "service"
      ? model.services.some(({ id }) => id === nodeId)
      : model.junctions.some(({ id }) => id === nodeId);
  if (!exists) {
    return unchangedArchitectureCommand(
      model,
      { kind: "diagram" },
      "canvas",
      `architecture.${kind}-not-found`,
    );
  }
  const next = cloneArchitectureModel(model);
  const removedEdgeIds = next.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map(({ id }) => id);
  const removedEdgeIdSet = new Set(removedEdgeIds);
  const previousAlignments = next.alignments;
  next.services = next.services.filter(({ id }) => id !== nodeId);
  next.junctions = next.junctions.filter(({ id }) => id !== nodeId);
  next.edges = next.edges.filter(({ id }) => !removedEdgeIdSet.has(id));
  next.alignments = next.alignments
    .map((alignment) => ({
      ...alignment,
      members: alignment.members.filter((member) => member !== nodeId),
    }))
    .filter((alignment) => alignment.members.length >= 2);
  const retainedAlignmentIds = new Set(next.alignments.map(({ id }) => id));
  const removedAlignmentIds = previousAlignments
    .filter(({ id }) => !retainedAlignmentIds.has(id))
    .map(({ id }) => id);
  const removedAlignmentIdSet = new Set(removedAlignmentIds);
  const removedCommentIds = (next.comments ?? [])
    .filter(
      (comment) =>
        (comment.anchorId === nodeId &&
          (comment.anchorKind === "service" ||
            comment.anchorKind === "junction")) ||
        (comment.anchorKind === "edge" &&
          Boolean(comment.anchorId) &&
          removedEdgeIdSet.has(comment.anchorId!)) ||
        (comment.anchorKind === "alignment" &&
          Boolean(comment.anchorId) &&
          removedAlignmentIdSet.has(comment.anchorId!)),
    )
    .map(({ id }) => id);
  const removedCommentIdSet = new Set(removedCommentIds);
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
    {
      removedAlignmentIds,
      removedCommentIds,
      removedEdgeIds,
      removedObjectIds: [nodeId],
    },
  );
}

export function deleteMermaidArchitectureService(
  model: MermaidArchitectureModel,
  serviceId: string,
) {
  return deleteMermaidArchitectureNode(model, serviceId, "service");
}

export function deleteMermaidArchitectureJunction(
  model: MermaidArchitectureModel,
  junctionId: string,
) {
  return deleteMermaidArchitectureNode(model, junctionId, "junction");
}

export function deleteMermaidArchitectureGroup(
  model: MermaidArchitectureModel,
  groupId: string,
) {
  const group = model.groups.find(({ id }) => id === groupId);
  if (!group) {
    return unchangedArchitectureCommand(
      model,
      { kind: "diagram" },
      "canvas",
      "architecture.group-not-found",
    );
  }
  const next = cloneArchitectureModel(model);
  const removedCommentIds = (next.comments ?? [])
    .filter(
      (comment) =>
        comment.anchorKind === "group" && comment.anchorId === groupId,
    )
    .map(({ id }) => id);
  const removedCommentIdSet = new Set(removedCommentIds);
  const reparentedObjectIds = [
    ...next.groups.filter(({ parentId }) => parentId === groupId),
    ...next.services.filter(({ groupId: parentId }) => parentId === groupId),
    ...next.junctions.filter(({ groupId: parentId }) => parentId === groupId),
  ].map(({ id }) => id);
  next.groups = next.groups
    .filter(({ id }) => id !== groupId)
    .map((candidate) =>
      candidate.parentId === groupId
        ? { ...candidate, parentId: group.parentId }
        : candidate,
    );
  next.services = next.services.map((service) =>
    service.groupId === groupId
      ? { ...service, groupId: group.parentId }
      : service,
  );
  next.junctions = next.junctions.map((junction) =>
    junction.groupId === groupId
      ? { ...junction, groupId: group.parentId }
      : junction,
  );
  normalizeArchitectureEdgeGroupMarkers(next);
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
    { removedCommentIds, removedObjectIds: [groupId], reparentedObjectIds },
  );
}
