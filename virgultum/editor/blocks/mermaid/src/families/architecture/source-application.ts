// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  addMermaidArchitectureComment,
  addMermaidArchitectureEdge,
  addMermaidArchitectureGroup,
  addMermaidArchitectureJunction,
  addMermaidArchitectureService,
  convertMermaidArchitectureNode,
  deleteMermaidArchitectureAlignment,
  deleteMermaidArchitectureComment,
  deleteMermaidArchitectureEdge,
  deleteMermaidArchitectureGroup,
  deleteMermaidArchitectureJunction,
  deleteMermaidArchitectureService,
  generateMermaidArchitectureSource,
  mermaidArchitectureDiagramConfig,
  parseMermaidArchitectureSource,
  setMermaidArchitectureAlignment,
  updateMermaidArchitectureAlignment,
  updateMermaidArchitectureComment,
  updateMermaidArchitectureDiagram,
  updateMermaidArchitectureEdge,
  updateMermaidArchitectureGroup,
  updateMermaidArchitectureJunction,
  updateMermaidArchitectureService,
} from "../../engine/architecture/index.js";
import type {
  MermaidArchitectureComment,
  MermaidArchitectureCommandResult,
  MermaidArchitectureModel,
} from "../../engine/architecture/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  architectureEdgeGfxData,
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
  hasFiniteArchitectureGfxGeometry,
} from "./gfx-data.js";

function applyArchitectureSourceCommand(
  command: MermaidArchitectureCommandResult,
  operation: string,
) {
  if (command.changed) return command.model;
  if (command.diagnosis?.code === "architecture.no-change") {
    return command.model;
  }
  throw new Error(`Architecture source application rejected ${operation}.`);
}

function architectureCommentAnchorMatches(
  left: MermaidArchitectureComment,
  right: MermaidArchitectureComment,
) {
  return (
    left.anchorId === right.anchorId &&
    left.anchorKind === right.anchorKind &&
    left.position === right.position
  );
}

/**
 * Parser comment IDs describe source order, not persistent identity. Inserting
 * or removing an earlier comment therefore renumbers later comments after the
 * source roundtrip. Reconcile unchanged comments by their complete semantics
 * first and reserve same-anchor positional matching for actual text edits.
 */
function reconcileArchitectureCommentIds(
  current: readonly MermaidArchitectureComment[],
  desired: readonly MermaidArchitectureComment[],
) {
  const currentByDesired = new Map<number, MermaidArchitectureComment>();
  const available = new Set(current.map((_, index) => index));
  const match = (
    desiredIndex: number,
    predicate: (candidate: MermaidArchitectureComment) => boolean,
  ) => {
    const currentIndex = [...available].find((index) =>
      predicate(current[index]!),
    );
    if (currentIndex === undefined) return;
    available.delete(currentIndex);
    currentByDesired.set(desiredIndex, current[currentIndex]!);
  };

  desired.forEach((comment, index) =>
    match(
      index,
      (candidate) =>
        architectureCommentAnchorMatches(candidate, comment) &&
        candidate.line === comment.line,
    ),
  );
  desired.forEach((comment, index) => {
    if (currentByDesired.has(index)) return;
    match(
      index,
      (candidate) =>
        candidate.id === comment.id &&
        architectureCommentAnchorMatches(candidate, comment),
    );
  });
  desired.forEach((comment, index) => {
    if (currentByDesired.has(index)) return;
    match(index, (candidate) =>
      architectureCommentAnchorMatches(candidate, comment),
    );
  });

  const reservedIds = new Set(current.map(({ id }) => id));
  return desired.map((comment, index) => {
    const matched = currentByDesired.get(index);
    if (matched) return { ...comment, id: matched.id };
    let pendingId = `architecture-pending-comment-${index + 1}`;
    while (reservedIds.has(pendingId)) pendingId = `${pendingId}-next`;
    reservedIds.add(pendingId);
    return { ...comment, id: pendingId };
  });
}

function synchronizeArchitectureSourceModel(
  base: MermaidArchitectureModel,
  desired: MermaidArchitectureModel,
) {
  let model = base;
  const sourceEdgeIdByVisualId = new Map<string, string>();
  const desiredNodeIds = new Set([
    ...desired.services.map(({ id }) => id),
    ...desired.junctions.map(({ id }) => id),
  ]);
  const desiredGroupIds = new Set(desired.groups.map(({ id }) => id));
  const desiredEdgeIds = new Set(desired.edges.map(({ id }) => id));
  const desiredAlignmentIds = new Set(desired.alignments.map(({ id }) => id));
  const desiredComments = reconcileArchitectureCommentIds(
    base.comments ?? [],
    desired.comments ?? [],
  );
  const desiredCommentIds = new Set(desiredComments.map(({ id }) => id));

  for (const edge of model.edges) {
    if (!desiredEdgeIds.has(edge.id)) {
      model = applyArchitectureSourceCommand(
        deleteMermaidArchitectureEdge(model, edge.id),
        `relation deletion ${edge.id}`,
      );
    }
  }
  for (const alignment of model.alignments) {
    if (!desiredAlignmentIds.has(alignment.id)) {
      model = applyArchitectureSourceCommand(
        deleteMermaidArchitectureAlignment(model, alignment.id),
        `alignment deletion ${alignment.id}`,
      );
    }
  }
  for (const comment of model.comments ?? []) {
    if (!desiredCommentIds.has(comment.id)) {
      model = applyArchitectureSourceCommand(
        deleteMermaidArchitectureComment(model, comment.id),
        `comment deletion ${comment.id}`,
      );
    }
  }
  for (const service of model.services) {
    if (!desiredNodeIds.has(service.id)) {
      model = applyArchitectureSourceCommand(
        deleteMermaidArchitectureService(model, service.id),
        `service deletion ${service.id}`,
      );
    }
  }
  for (const junction of model.junctions) {
    if (!desiredNodeIds.has(junction.id)) {
      model = applyArchitectureSourceCommand(
        deleteMermaidArchitectureJunction(model, junction.id),
        `junction deletion ${junction.id}`,
      );
    }
  }
  for (const group of model.groups.toReversed()) {
    if (!desiredGroupIds.has(group.id)) {
      model = applyArchitectureSourceCommand(
        deleteMermaidArchitectureGroup(model, group.id),
        `group deletion ${group.id}`,
      );
    }
  }

  const pendingGroups = new Map(
    desired.groups.map((group) => [group.id, group]),
  );
  while (pendingGroups.size) {
    let added = false;
    for (const [groupId, group] of pendingGroups) {
      if (model.groups.some((candidate) => candidate.id === groupId)) {
        pendingGroups.delete(groupId);
        added = true;
        continue;
      }
      if (
        group.parentId &&
        !model.groups.some((candidate) => candidate.id === group.parentId)
      ) {
        continue;
      }
      model = applyArchitectureSourceCommand(
        addMermaidArchitectureGroup(model, group),
        `group creation ${group.id}`,
      );
      pendingGroups.delete(groupId);
      added = true;
    }
    if (!added) {
      throw new Error("Architecture source application rejected group order.");
    }
  }

  for (const service of desired.services) {
    const hasService = model.services.some(({ id }) => id === service.id);
    const hasJunction = model.junctions.some(({ id }) => id === service.id);
    if (hasJunction) {
      model = applyArchitectureSourceCommand(
        convertMermaidArchitectureNode(model, service.id, "service"),
        `service conversion ${service.id}`,
      );
    } else if (!hasService) {
      model = applyArchitectureSourceCommand(
        addMermaidArchitectureService(model, service),
        `service creation ${service.id}`,
      );
    }
  }
  for (const junction of desired.junctions) {
    const hasService = model.services.some(({ id }) => id === junction.id);
    const hasJunction = model.junctions.some(({ id }) => id === junction.id);
    if (hasService) {
      model = applyArchitectureSourceCommand(
        convertMermaidArchitectureNode(model, junction.id, "junction"),
        `junction conversion ${junction.id}`,
      );
    } else if (!hasJunction) {
      model = applyArchitectureSourceCommand(
        addMermaidArchitectureJunction(model, junction),
        `junction creation ${junction.id}`,
      );
    }
  }

  for (const group of desired.groups) {
    model = applyArchitectureSourceCommand(
      updateMermaidArchitectureGroup(model, group.id, group),
      `group update ${group.id}`,
    );
  }
  for (const service of desired.services) {
    model = applyArchitectureSourceCommand(
      updateMermaidArchitectureService(model, service.id, service),
      `service update ${service.id}`,
    );
  }
  for (const junction of desired.junctions) {
    model = applyArchitectureSourceCommand(
      updateMermaidArchitectureJunction(model, junction.id, junction),
      `junction update ${junction.id}`,
    );
  }

  for (const edge of desired.edges) {
    if (model.edges.some((candidate) => candidate.id === edge.id)) {
      model = applyArchitectureSourceCommand(
        updateMermaidArchitectureEdge(model, edge.id, edge),
        `relation update ${edge.id}`,
      );
      continue;
    }
    const command = addMermaidArchitectureEdge(model, edge.from, edge.to, edge);
    if (!command.changed || !command.selectionAfter.id) {
      throw new Error(
        `Architecture source application rejected relation creation ${edge.id}.`,
      );
    }
    sourceEdgeIdByVisualId.set(edge.id, command.selectionAfter.id);
    model = command.model;
  }
  for (const alignment of desired.alignments) {
    if (model.alignments.some((candidate) => candidate.id === alignment.id)) {
      model = applyArchitectureSourceCommand(
        updateMermaidArchitectureAlignment(
          model,
          alignment.id,
          alignment.members,
          alignment.direction,
        ),
        `alignment update ${alignment.id}`,
      );
      continue;
    }
    const command = setMermaidArchitectureAlignment(
      model,
      alignment.members,
      alignment.direction,
    );
    if (!command.changed || command.selectionAfter.id !== alignment.id) {
      throw new Error(
        `Architecture source application rejected alignment creation ${alignment.id}.`,
      );
    }
    model = command.model;
  }
  for (const comment of desiredComments) {
    const current = model.comments?.find(
      (candidate) => candidate.id === comment.id,
    );
    if (current) {
      if (
        current.anchorId !== comment.anchorId ||
        current.anchorKind !== comment.anchorKind ||
        current.position !== comment.position
      ) {
        throw new Error(
          `Architecture source application rejected comment anchor ${comment.id}.`,
        );
      }
      model = applyArchitectureSourceCommand(
        updateMermaidArchitectureComment(model, comment.id, comment.line),
        `comment update ${comment.id}`,
      );
      continue;
    }
    const command = addMermaidArchitectureComment(
      model,
      {
        anchorId:
          comment.anchorKind === "edge" && comment.anchorId
            ? (sourceEdgeIdByVisualId.get(comment.anchorId) ?? comment.anchorId)
            : comment.anchorId,
        anchorKind: comment.anchorKind,
        position: comment.position,
      },
      comment.line,
    );
    if (!command.changed || !command.selectionAfter.id) {
      throw new Error(
        `Architecture source application rejected comment creation ${comment.id}.`,
      );
    }
    model = command.model;
  }
  model = applyArchitectureSourceCommand(
    updateMermaidArchitectureDiagram(model, {
      accessibilityDescription: desired.accessibilityDescription,
      accessibilityTitle: desired.accessibilityTitle,
      config: mermaidArchitectureDiagramConfig(desired),
    }),
    "diagram update",
  );
  return model;
}

export function applyArchitectureGfxVisualToSource(
  source: string,
  visualModel: MermaidVisualModel,
) {
  const parsed = parseMermaidArchitectureSource(source);
  if (
    !parsed?.sourceDocument ||
    !hasFiniteArchitectureGfxGeometry(visualModel)
  ) {
    throw new Error(
      "Architecture source application requires valid source and finite geometry.",
    );
  }
  const sourceNodeOrder = new Map(
    parsed.sourceDocument.records.flatMap((record) =>
      record.kind === "statement" &&
      (record.statementKind === "service" ||
        record.statementKind === "junction")
        ? [[record.id, record.startLine] as const]
        : [],
    ),
  );
  const sourceNodeIdentity = new Map(
    visualModel.nodes.map(
      (node) =>
        [node.id, architectureNodeGfxData(node)?.sourceId || node.id] as const,
    ),
  );
  const sourceOrderForNode = (id: string, fallback: number) =>
    sourceNodeOrder.get(sourceNodeIdentity.get(id) ?? id) ?? fallback;
  let base: MermaidArchitectureModel = parsed;
  for (const subgraph of visualModel.subgraphs ?? []) {
    const sourceId = architectureSubgraphGfxData(subgraph)?.sourceId;
    if (!sourceId || sourceId === subgraph.id) continue;
    const command: MermaidArchitectureCommandResult =
      updateMermaidArchitectureGroup(base, sourceId, {
        id: subgraph.id,
      });
    if (!command.changed) {
      throw new Error("Architecture group ID reconciliation failed.");
    }
    base = command.model;
  }
  for (const node of visualModel.nodes) {
    const architecture = architectureNodeGfxData(node);
    const sourceId = architecture?.sourceId;
    if (!sourceId || sourceId === node.id) continue;
    const command: MermaidArchitectureCommandResult =
      architecture.kind === "junction"
        ? updateMermaidArchitectureJunction(base, sourceId, { id: node.id })
        : updateMermaidArchitectureService(base, sourceId, { id: node.id });
    if (!command.changed) {
      throw new Error("Architecture node ID reconciliation failed.");
    }
    base = command.model;
  }
  const groupById = new Map(base.groups.map((group) => [group.id, group]));
  const visualGroupIds = new Set(
    (visualModel.subgraphs ?? []).map((subgraph) => subgraph.id),
  );
  const survivingGroupId = (groupId: string | undefined) => {
    const visited = new Set<string>();
    let candidate = groupId ?? "";
    while (candidate && !visited.has(candidate)) {
      if (visualGroupIds.has(candidate)) return candidate;
      visited.add(candidate);
      candidate = groupById.get(candidate)?.parentId ?? "";
    }
    return "";
  };
  const groups = (visualModel.subgraphs ?? []).map((subgraph, index) => {
    const existing = groupById.get(subgraph.id);
    const architecture = architectureSubgraphGfxData(subgraph);
    const preservedLabel =
      architecture?.label ?? existing?.label ?? subgraph.id;
    const preservedIcon = architecture?.icon ?? existing?.icon ?? "";
    const hasIcon = architecture?.hasIcon ?? existing?.hasIcon ?? false;
    const preservedHasLabel =
      architecture?.hasLabel ?? existing?.hasLabel ?? false;
    const expectedTitle = preservedHasLabel ? preservedLabel : subgraph.id;
    const titleChanged = subgraph.title !== expectedTitle;
    const sourceLabel = titleChanged ? subgraph.title : preservedLabel;
    const hasLabel = titleChanged ? Boolean(sourceLabel) : preservedHasLabel;
    return {
      hasIcon,
      hasLabel,
      icon: preservedIcon,
      id: subgraph.id,
      label: hasLabel ? sourceLabel : "",
      order: index,
      parentId:
        architecture?.parentId === ""
          ? ""
          : survivingGroupId(architecture?.parentId ?? existing?.parentId),
    };
  });
  const visualNodeIds = new Set(visualModel.nodes.map((node) => node.id));
  const existingServices = new Map(
    base.services.map((service) => [service.id, service]),
  );
  const existingJunctions = new Map(
    base.junctions.map((junction) => [junction.id, junction]),
  );
  const services = visualModel.nodes
    .flatMap((node, order) => {
      const architecture = architectureNodeGfxData(node);
      const existingJunction = existingJunctions.get(node.id);
      if (
        architecture?.kind === "junction" ||
        (!architecture && existingJunction) ||
        (!architecture &&
          !existingServices.has(node.id) &&
          node.shape === "circle")
      ) {
        return [];
      }
      const existing = existingServices.get(node.id);
      const originalDisplayLabel = existing?.label || existing?.id || node.id;
      const visualLabel = node.label.replaceAll("\r", "");
      const labelUnchanged = visualLabel === originalDisplayLabel;
      const effectiveHasLabel = labelUnchanged
        ? (architecture?.hasLabel ?? existing?.hasLabel ?? false)
        : Boolean(visualLabel);
      const sourceLabel = labelUnchanged
        ? (architecture?.label ?? existing?.label ?? "")
        : visualLabel;
      return [
        {
          groupId:
            architecture?.groupId === ""
              ? ""
              : survivingGroupId(architecture?.groupId ?? existing?.groupId),
          hasIcon: architecture?.hasIcon ?? existing?.hasIcon ?? false,
          hasLabel: effectiveHasLabel,
          icon: architecture?.icon ?? existing?.icon ?? "",
          iconKind:
            architecture?.iconKind ?? existing?.iconKind ?? ("none" as const),
          id: node.id,
          label: effectiveHasLabel ? sourceLabel : "",
          order: sourceOrderForNode(node.id, order),
        },
      ];
    })
    .sort((left, right) => left.order - right.order)
    .map((service, order) => ({ ...service, order }));
  const junctions = visualModel.nodes
    .flatMap((node, order) => {
      const architecture = architectureNodeGfxData(node);
      const existingService = existingServices.get(node.id);
      const existing = existingJunctions.get(node.id);
      const isJunction =
        architecture?.kind === "junction" ||
        (!architecture &&
          !existingService &&
          Boolean(existing || node.shape === "circle"));
      if (!isJunction) return [];
      return [
        {
          groupId:
            architecture?.groupId === ""
              ? ""
              : survivingGroupId(architecture?.groupId ?? existing?.groupId),
          id: node.id,
          order: sourceOrderForNode(node.id, existing?.order ?? order),
        },
      ];
    })
    .sort((left, right) => left.order - right.order)
    .map((junction, order) => ({ ...junction, order }));
  const existingEdges = new Map(base.edges.map((edge) => [edge.id, edge]));
  const projected = architectureModelGfxData(visualModel);
  if (
    projected?.config &&
    JSON.stringify(projected.config) !==
      JSON.stringify(mermaidArchitectureDiagramConfig(base))
  ) {
    const command: MermaidArchitectureCommandResult =
      updateMermaidArchitectureDiagram(base, {
        config: projected.config,
      });
    if (
      !command.changed &&
      command.diagnosis?.code !== "architecture.no-change"
    ) {
      throw new Error("Architecture configuration reconciliation failed.");
    }
    base = command.model;
  }
  const alignments = (projected?.alignments ?? base.alignments)
    .map((alignment) => ({
      ...alignment,
      members: alignment.members.filter((id) => visualNodeIds.has(id)),
    }))
    .filter((alignment) => alignment.members.length >= 2);
  const edges = visualModel.edges.map((edge, order) => {
    const architecture = architectureEdgeGfxData(edge);
    const sourceId = architecture?.sourceId || edge.id;
    const existing = existingEdges.get(sourceId);
    return {
      ...existing,
      from: edge.source,
      fromArrow: architecture?.fromArrow ?? existing?.fromArrow ?? false,
      fromGroup: architecture?.fromGroup ?? existing?.fromGroup ?? false,
      fromPort: architecture?.fromPort ?? existing?.fromPort ?? "R",
      id: sourceId,
      label: edge.label,
      order,
      to: edge.target,
      toArrow: architecture?.toArrow ?? existing?.toArrow ?? true,
      toGroup: architecture?.toGroup ?? existing?.toGroup ?? false,
      toPort: architecture?.toPort ?? existing?.toPort ?? "L",
    };
  });
  const liveAnchors = {
    alignment: new Set(alignments.map((alignment) => alignment.id)),
    edge: new Set(edges.map((edge) => edge.id)),
    group: new Set(groups.map((group) => group.id)),
    junction: new Set(junctions.map((junction) => junction.id)),
    service: new Set(services.map((service) => service.id)),
  };
  const comments = (projected?.comments ?? base.comments)?.filter((comment) => {
    if (comment.anchorKind === "diagram" || comment.anchorKind === "metadata") {
      return true;
    }
    return Boolean(
      comment.anchorId && liveAnchors[comment.anchorKind].has(comment.anchorId),
    );
  });

  const desired: MermaidArchitectureModel = {
    ...base,
    accessibilityDescription:
      visualModel.accessibilityDescription ?? base.accessibilityDescription,
    accessibilityTitle:
      visualModel.accessibilityTitle ?? base.accessibilityTitle,
    alignments,
    comments,
    edges,
    groups,
    // Configuration reconciliation above writes the authoritative directive
    // text into the ordered source document. Reapplying the incoming GFX copy
    // can differ only by JSON member order (for example when adding an
    // explicit `false`) and would make the model disagree with that document.
    directives: [...base.directives],
    diagramTitle:
      base.diagramTitle ||
      (base.directives.length || visualModel.sourcePreamble?.length
        ? base.diagramTitle
        : (visualModel.diagramTitle ?? "")),
    junctions,
    sourceAnnotations: visualModel.sourceAnnotations ?? base.sourceAnnotations,
    services,
  };
  const candidate = generateMermaidArchitectureSource(
    synchronizeArchitectureSourceModel(base, desired),
  );
  return candidate;
}
