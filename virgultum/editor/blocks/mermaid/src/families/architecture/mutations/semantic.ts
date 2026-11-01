// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  convertMermaidArchitectureNode,
  updateMermaidArchitectureEdge,
  updateMermaidArchitectureGroup,
  updateMermaidArchitectureJunction,
  updateMermaidArchitectureService,
  type MermaidArchitectureCommandResult,
  type MermaidArchitectureModel,
} from "../../../engine/architecture/index.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import { architectureEdgeGfxData } from "../gfx-data.js";
import type { MermaidArchitectureMutationControl } from "../mutation-contract.js";
import { projectArchitectureSemanticCommand } from "./projection.js";

export type MermaidArchitectureFieldValue = {
  readonly control: MermaidArchitectureMutationControl;
  readonly value: string;
};

export type MermaidArchitectureSelection = {
  readonly edgeId?: string;
  readonly nodeId?: string;
  readonly subgraphId?: string;
};

type ArchitectureSemanticMutationResult =
  | {
      readonly changed: false;
      readonly command: MermaidArchitectureCommandResult;
    }
  | {
      readonly changed: true;
      readonly model: MermaidArchitectureModel;
      readonly selectionAfter: MermaidArchitectureCommandResult["selectionAfter"];
      readonly visualModel: MermaidVisualModel;
    };

function rejectedArchitectureFieldCommand(
  model: MermaidArchitectureModel,
): MermaidArchitectureCommandResult {
  return {
    changed: false,
    diagnosis: { code: "architecture.property-not-applicable" },
    focusAfter: "canvas",
    model,
    selectionAfter: { kind: "diagram" },
  };
}

/**
 * Resolves one visible Architecture field edit to its authoritative command.
 * This module deliberately never patches the GFX model itself: the command
 * result is projected by `projection.ts` and committed through the shared
 * source-application boundary.
 */
export function architectureSemanticFieldCommand(
  model: MermaidArchitectureModel,
  visualModel: MermaidVisualModel,
  selection: MermaidArchitectureSelection,
  { control, value }: MermaidArchitectureFieldValue,
): MermaidArchitectureCommandResult {
  const nodeId = selection.nodeId ?? "";
  const groupId = selection.subgraphId ?? "";
  const visualEdge = visualModel.edges.find(
    (candidate) => candidate.id === selection.edgeId,
  );
  const edgeId = visualEdge
    ? architectureEdgeGfxData(visualEdge)?.sourceId || visualEdge.id
    : "";
  const service = model.services.find((candidate) => candidate.id === nodeId);
  const junction = model.junctions.find((candidate) => candidate.id === nodeId);
  const group = model.groups.find((candidate) => candidate.id === groupId);
  const edge = model.edges.find((candidate) => candidate.id === edgeId);

  if (control === "architectureNodeId") {
    if (service) {
      return updateMermaidArchitectureService(model, service.id, {
        id: value.trim(),
      });
    }
    if (junction) {
      return updateMermaidArchitectureJunction(model, junction.id, {
        id: value.trim(),
      });
    }
  }
  if (control === "architectureGroupId" && group) {
    return updateMermaidArchitectureGroup(model, group.id, {
      id: value.trim(),
    });
  }
  if (control === "nodeLabel" && service) {
    const label = value.trim();
    return updateMermaidArchitectureService(model, service.id, {
      hasLabel: Boolean(label),
      label,
    });
  }
  if (control === "subgraphTitle" && group) {
    const label = value.trim();
    return updateMermaidArchitectureGroup(model, group.id, {
      hasLabel: Boolean(label),
      label,
    });
  }
  if (control === "architectureNodeGroup") {
    if (service) {
      return updateMermaidArchitectureService(model, service.id, {
        groupId: value,
      });
    }
    if (junction) {
      return updateMermaidArchitectureJunction(model, junction.id, {
        groupId: value,
      });
    }
  }
  if (control === "architectureGroupParent" && group) {
    return updateMermaidArchitectureGroup(model, group.id, {
      parentId: value,
    });
  }
  if (control === "architectureGroupIcon" && group) {
    const icon = value.trim();
    return updateMermaidArchitectureGroup(model, group.id, {
      hasIcon: Boolean(icon),
      icon,
    });
  }
  if (control === "architectureNodeKind" && (service || junction)) {
    if (value !== "junction" && value !== "service") {
      return rejectedArchitectureFieldCommand(model);
    }
    return convertMermaidArchitectureNode(model, nodeId, value);
  }
  if (control === "architectureServiceIcon" && service) {
    const icon = value.trim();
    const iconKind =
      service.iconKind === "text" ? "text" : icon ? "icon" : "none";
    return updateMermaidArchitectureService(model, service.id, {
      hasIcon: Boolean(icon),
      icon,
      iconKind,
    });
  }
  if (control === "architectureServiceIconKind" && service) {
    if (value !== "icon" && value !== "none" && value !== "text") {
      return rejectedArchitectureFieldCommand(model);
    }
    return updateMermaidArchitectureService(model, service.id, {
      hasIcon: value !== "none" && Boolean(service.icon),
      iconKind: value,
    });
  }
  if (control === "architectureFromPort" && edge) {
    return updateMermaidArchitectureEdge(model, edge.id, {
      fromPort: value,
    });
  }
  if (control === "architectureToPort" && edge) {
    return updateMermaidArchitectureEdge(model, edge.id, {
      toPort: value,
    });
  }
  if (control === "architectureFromArrow" && edge) {
    if (value !== "arrow" && value !== "none") {
      return rejectedArchitectureFieldCommand(model);
    }
    return updateMermaidArchitectureEdge(model, edge.id, {
      fromArrow: value === "arrow",
    });
  }
  if (control === "architectureToArrow" && edge) {
    if (value !== "arrow" && value !== "none") {
      return rejectedArchitectureFieldCommand(model);
    }
    return updateMermaidArchitectureEdge(model, edge.id, {
      toArrow: value === "arrow",
    });
  }
  if (control === "architectureFromGroup" && edge) {
    if (value !== "group" && value !== "object") {
      return rejectedArchitectureFieldCommand(model);
    }
    return updateMermaidArchitectureEdge(model, edge.id, {
      fromGroup: value === "group",
    });
  }
  if (control === "architectureToGroup" && edge) {
    if (value !== "group" && value !== "object") {
      return rejectedArchitectureFieldCommand(model);
    }
    return updateMermaidArchitectureEdge(model, edge.id, {
      toGroup: value === "group",
    });
  }
  if (control === "edgeLabel" && edge) {
    return updateMermaidArchitectureEdge(
      model,
      edge.id,
      { label: value.trim() },
      "edge-label",
    );
  }
  return rejectedArchitectureFieldCommand(model);
}

function selectionForNextArchitectureCommand(
  selection: MermaidArchitectureSelection,
  command: MermaidArchitectureCommandResult,
): MermaidArchitectureSelection {
  const id = command.selectionAfter.id;
  if (!id) return selection;
  if (
    command.selectionAfter.kind === "service" ||
    command.selectionAfter.kind === "junction"
  ) {
    return { nodeId: id };
  }
  if (command.selectionAfter.kind === "group") return { subgraphId: id };
  if (command.selectionAfter.kind === "edge") {
    // GFX edge identity is intentionally stable and can differ from the
    // source-statement identity returned by the command.
    return { edgeId: selection.edgeId ?? id };
  }
  return selection;
}

export function applyArchitectureSemanticFieldMutations(
  model: MermaidArchitectureModel,
  visualModel: MermaidVisualModel,
  selection: MermaidArchitectureSelection,
  values: readonly MermaidArchitectureFieldValue[],
): ArchitectureSemanticMutationResult {
  let nextModel = model;
  let nextSelection = selection;
  let selectionAfter: MermaidArchitectureCommandResult["selectionAfter"] = {
    ...(selection.edgeId ? { id: selection.edgeId } : {}),
    ...(selection.nodeId ? { id: selection.nodeId } : {}),
    ...(selection.subgraphId ? { id: selection.subgraphId } : {}),
    kind: selection.edgeId
      ? "edge"
      : selection.subgraphId
        ? "group"
        : "service",
  };
  for (const value of values) {
    const command = architectureSemanticFieldCommand(
      nextModel,
      visualModel,
      nextSelection,
      value,
    );
    if (!command.changed) return { changed: false, command };
    nextModel = command.model;
    nextSelection = selectionForNextArchitectureCommand(nextSelection, command);
    selectionAfter = command.selectionAfter;
  }
  const projected = projectArchitectureSemanticCommand({
    model: nextModel,
    selectionAfter,
    selectionBefore: selection,
    visualModel,
  });
  if (!projected) {
    return {
      changed: false,
      command: {
        changed: false,
        diagnosis: { code: "architecture.visual-projection-rejected" },
        focusAfter: "canvas",
        model,
        selectionAfter,
      },
    };
  }
  return {
    changed: true,
    model: nextModel,
    selectionAfter,
    visualModel: projected,
  };
}
