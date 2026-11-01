// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateMermaidCommonMetadataLines } from "../../common-metadata.js";
import {
  ARCHITECTURE_ICON_VALUE_RE,
  architectureTitleSource,
  quotedArchitectureString,
} from "../grammar.js";
import type {
  MermaidArchitectureAlignment,
  MermaidArchitectureComment,
  MermaidArchitectureEdge,
  MermaidArchitectureGroup,
  MermaidArchitectureJunction,
  MermaidArchitectureModel,
  MermaidArchitectureService,
} from "../model.js";

export function orderedArchitectureGroups(model: MermaidArchitectureModel) {
  const pendingGroups = [...model.groups].sort((a, b) => a.order - b.order);
  const orderedGroups: MermaidArchitectureGroup[] = [];
  const emittedGroupIds = new Set<string>();
  while (pendingGroups.length) {
    const nextIndex = pendingGroups.findIndex(
      (group) => !group.parentId || emittedGroupIds.has(group.parentId),
    );
    if (nextIndex < 0) break;
    const [group] = pendingGroups.splice(nextIndex, 1);
    orderedGroups.push(group);
    emittedGroupIds.add(group.id);
  }
  if (pendingGroups.length) {
    throw new Error(
      "Architecture groups contain a cyclic parent relationship.",
    );
  }
  return orderedGroups;
}

export function architectureGroupSource(group: MermaidArchitectureGroup) {
  if (group.hasIcon && !ARCHITECTURE_ICON_VALUE_RE.test(group.icon)) {
    throw new Error(`Invalid Architecture group icon for ${group.id}.`);
  }
  const parent = group.parentId ? ` in ${group.parentId}` : "";
  const icon = group.hasIcon ? `(${group.icon})` : "";
  const title = group.hasLabel ? architectureTitleSource(group.label) : "";
  return `  group ${group.id}${icon}${title}${parent}`;
}

export function architectureServiceSource(service: MermaidArchitectureService) {
  if (
    service.hasIcon &&
    service.iconKind === "icon" &&
    !ARCHITECTURE_ICON_VALUE_RE.test(service.icon)
  ) {
    throw new Error(`Invalid Architecture service icon for ${service.id}.`);
  }
  const group = service.groupId ? ` in ${service.groupId}` : "";
  const icon = !service.hasIcon
    ? ""
    : service.iconKind === "text"
      ? quotedArchitectureString(service.icon)
      : `(${service.icon})`;
  const title = service.hasLabel ? architectureTitleSource(service.label) : "";
  return `  service ${service.id}${icon}${title}${group}`;
}

export function architectureJunctionSource(
  junction: MermaidArchitectureJunction,
) {
  const group = junction.groupId ? ` in ${junction.groupId}` : "";
  return `  junction ${junction.id}${group}`;
}

export function architectureEdgeSource(
  edge: MermaidArchitectureEdge,
  model: MermaidArchitectureModel,
) {
  const groupIdByNodeId = new Map([
    ...model.services.map((service) => [service.id, service.groupId] as const),
    ...model.junctions.map(
      (junction) => [junction.id, junction.groupId] as const,
    ),
  ]);
  const fromGroupId = groupIdByNodeId.get(edge.from);
  const toGroupId = groupIdByNodeId.get(edge.to);
  if (fromGroupId === undefined || toGroupId === undefined) {
    throw new Error(`Architecture edge ${edge.id} has a missing endpoint.`);
  }
  if (!/^[RLTB]$/.test(edge.fromPort) || !/^[RLTB]$/.test(edge.toPort)) {
    throw new Error(`Architecture edge ${edge.id} has an invalid port.`);
  }
  if (
    (edge.fromGroup || edge.toGroup) &&
    Boolean(fromGroupId) &&
    fromGroupId === toGroupId
  ) {
    throw new Error(
      `Architecture edge ${edge.id} cannot use {group} within one group.`,
    );
  }
  const fromGroup = edge.fromGroup ? "{group}" : "";
  const toGroup = edge.toGroup ? "{group}" : "";
  const arrow = `${edge.fromArrow ? "<" : ""}-${
    edge.label ? architectureTitleSource(edge.label) : ""
  }-${edge.toArrow ? ">" : ""}`;
  return `  ${edge.from}${fromGroup}:${edge.fromPort} ${arrow} ${edge.toPort}:${edge.to}${toGroup}`;
}

export function architectureAlignmentSource(
  alignment: MermaidArchitectureAlignment,
) {
  return `  align ${alignment.direction} ${alignment.members.join(" ")}`;
}

export function generateCanonicalArchitectureSource(
  model: MermaidArchitectureModel,
) {
  const comments = model.comments ?? [];
  const emittedComments = new Set<string>();
  const commentLines = (
    anchorKind: MermaidArchitectureComment["anchorKind"],
    anchorId: string | undefined,
    position: MermaidArchitectureComment["position"],
  ) =>
    comments
      .filter(
        (comment) =>
          comment.anchorKind === anchorKind &&
          comment.anchorId === anchorId &&
          comment.position === position,
      )
      .map((comment) => {
        emittedComments.add(comment.id);
        return comment.line;
      });
  const lineWithComments = (
    line: string,
    anchorKind: MermaidArchitectureComment["anchorKind"],
    anchorId?: string,
  ) => {
    const inline = commentLines(anchorKind, anchorId, "after");
    return `${line}${inline.length ? ` ${inline.join(" ")}` : ""}`;
  };
  const lines = [
    ...model.directives,
    ...commentLines("diagram", undefined, "before"),
    lineWithComments(model.headerLine || "architecture-beta", "diagram"),
  ];
  const addMetadata = (
    field: "accessibilityDescription" | "accessibilityTitle" | "diagramTitle",
    metadataLines: string[],
  ) => {
    if (!metadataLines.length) return;
    lines.push(...commentLines("metadata", field, "before"));
    const last = metadataLines.pop()!;
    lines.push(...metadataLines, lineWithComments(last, "metadata", field));
  };
  addMetadata(
    "diagramTitle",
    model.diagramTitle ? [`  title ${model.diagramTitle}`] : [],
  );
  addMetadata(
    "accessibilityTitle",
    model.accessibilityTitle ? [`  accTitle: ${model.accessibilityTitle}`] : [],
  );
  addMetadata(
    "accessibilityDescription",
    model.accessibilityDescription
      ? generateMermaidCommonMetadataLines({
          accessibilityDescription: model.accessibilityDescription,
          accessibilityTitle: "",
          diagramTitle: "",
        })
      : [],
  );
  const addStatement = (
    line: string,
    kind: MermaidArchitectureComment["anchorKind"],
    id: string,
  ) =>
    lines.push(
      ...commentLines(kind, id, "before"),
      lineWithComments(line, kind, id),
    );
  for (const group of orderedArchitectureGroups(model)) {
    addStatement(architectureGroupSource(group), "group", group.id);
  }
  for (const service of [...model.services].sort((a, b) => a.order - b.order)) {
    addStatement(architectureServiceSource(service), "service", service.id);
  }
  for (const junction of [...model.junctions].sort(
    (a, b) => a.order - b.order,
  )) {
    addStatement(architectureJunctionSource(junction), "junction", junction.id);
  }
  for (const edge of [...model.edges].sort((a, b) => a.order - b.order)) {
    addStatement(architectureEdgeSource(edge, model), "edge", edge.id);
  }
  for (const alignment of [...model.alignments].sort(
    (a, b) => a.order - b.order,
  )) {
    addStatement(
      architectureAlignmentSource(alignment),
      "alignment",
      alignment.id,
    );
  }
  lines.push(...commentLines("diagram", "end", "before"));
  lines.push(
    ...comments
      .filter((comment) => !emittedComments.has(comment.id))
      .map((comment) => comment.line),
  );
  if (!model.comments) {
    lines.push(...model.sourceAnnotations.filter((line) => line.trim()));
  }
  return `${lines.join("\n")}\n`;
}
