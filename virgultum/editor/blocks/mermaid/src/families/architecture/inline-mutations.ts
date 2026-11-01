// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { resolveArchitectureFieldsInteraction } from "./interaction-controller.js";
import type {
  MermaidArchitectureFieldValue,
  MermaidArchitectureSelection,
} from "./mutations/index.js";
import {
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";

function architectureInlineLabel(value: string) {
  return /[\r\n]/.test(value) ? null : value;
}

export function architectureGfxNodeInlineValue(
  model: MermaidVisualModel,
  nodeId: string,
) {
  if (model.diagramType !== "architecture") return null;
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  const architecture = node ? architectureNodeGfxData(node) : undefined;
  return architecture?.hasLabel ? architecture.label : "";
}

export function architectureGfxSubgraphInlineValue(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  if (model.diagramType !== "architecture") return null;
  const subgraph = model.subgraphs?.find(
    (candidate) => candidate.id === subgraphId,
  );
  const architecture = subgraph
    ? architectureSubgraphGfxData(subgraph)
    : undefined;
  return architecture?.hasLabel ? architecture.label : "";
}

function applyArchitectureInlineCommand(
  visualModel: MermaidVisualModel,
  source: string | undefined,
  selection: MermaidArchitectureSelection,
  field: MermaidArchitectureFieldValue,
) {
  if (visualModel.diagramType !== "architecture" || source === undefined) {
    return null;
  }
  const value = architectureInlineLabel(field.value);
  if (value === null) return null;
  const mutation = resolveArchitectureFieldsInteraction(
    source,
    visualModel,
    selection,
    [{ ...field, value }],
  );
  return mutation.changed ? mutation.visualModel : null;
}

export function renameArchitectureGfxNodeInline(
  model: MermaidVisualModel,
  nodeId: string,
  value: string,
  source?: string,
) {
  return applyArchitectureInlineCommand(
    model,
    source,
    { nodeId },
    { control: "nodeLabel", value },
  );
}

export function renameArchitectureGfxSubgraphInline(
  model: MermaidVisualModel,
  subgraphId: string,
  value: string,
  source?: string,
) {
  return applyArchitectureInlineCommand(
    model,
    source,
    { subgraphId },
    { control: "subgraphTitle", value },
  );
}

export function renameArchitectureGfxEdgeInline(
  model: MermaidVisualModel,
  edgeId: string,
  value: string,
  source?: string,
) {
  return applyArchitectureInlineCommand(
    model,
    source,
    { edgeId },
    { control: "edgeLabel", value },
  );
}
