// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { mermaidGfxLayoutMetrics } from "../../mermaid-gfx-theme.js";
import {
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import { resolveMermaidArchitectureConfig } from "../../engine/architecture/index.js";
import { architectureIconDisplay } from "./icon-display.js";
import {
  architectureConfiguredTypography,
  architectureGroupMeasurement,
} from "./layout/measurement.js";

/**
 * Fits Architecture groups to their direct semantic children.
 *
 * The function changes group bounds only. Node geometry remains the user's
 * geometry, while nested groups are resolved from the inside out so the
 * generic Mermaid projection owner can derive one content bound from the
 * resulting direct-child model in embedded and native consumers alike.
 */
export function fitArchitectureOwnerGroupsToDirectChildren(
  model: MermaidVisualModel,
): MermaidVisualModel {
  if (model.diagramType !== "architecture") return model;
  const config = resolveMermaidArchitectureConfig(
    architectureModelGfxData(model)?.config ?? {},
  );
  const titleTypography = architectureConfiguredTypography(config);
  const groupMetrics = mermaidGfxLayoutMetrics(titleTypography);
  const subgraphs = (model.subgraphs ?? []).map((subgraph) => ({
    ...subgraph,
    nodeIds: model.nodes
      .filter(
        (node) =>
          (architectureNodeGfxData(node)?.groupId ?? "") === subgraph.id,
      )
      .map((node) => node.id),
  }));
  const childrenByParent = new Map<string, MermaidVisualSubgraph[]>();
  for (const subgraph of subgraphs) {
    const parentId = architectureSubgraphGfxData(subgraph)?.parentId ?? "";
    const children = childrenByParent.get(parentId) ?? [];
    children.push(subgraph);
    childrenByParent.set(parentId, children);
  }
  const directNodesByGroup = new Map<string, MermaidVisualNode[]>();
  for (const node of model.nodes) {
    const groupId = architectureNodeGfxData(node)?.groupId ?? "";
    const nodes = directNodesByGroup.get(groupId) ?? [];
    nodes.push(node);
    directNodesByGroup.set(groupId, nodes);
  }
  const fit = (subgraph: MermaidVisualSubgraph) => {
    const children = childrenByParent.get(subgraph.id) ?? [];
    for (const child of children) fit(child);
    const contents = [
      ...(directNodesByGroup.get(subgraph.id) ?? []),
      ...children,
    ];
    if (!contents.length) return;
    const architecture = architectureSubgraphGfxData(subgraph);
    const measuredHeader = architectureGroupMeasurement(
      architecture?.label || subgraph.title,
      architectureIconDisplay(architecture?.icon ?? ""),
      architecture?.hasIcon ?? false,
      titleTypography,
      config.padding,
    );
    const headerHeight = measuredHeader.size.height;
    const headerWidth = measuredHeader.size.width;
    const left = Math.min(
      subgraph.x,
      ...contents.map((item) => item.x - groupMetrics.groupInlineInset),
    );
    const top = Math.min(
      subgraph.y,
      ...contents.map(
        (item) => item.y - headerHeight - groupMetrics.groupBlockInset,
      ),
    );
    const right = Math.max(
      subgraph.x + subgraph.width,
      left + headerWidth + groupMetrics.groupInlineInset * 2,
      ...contents.map(
        (item) => item.x + item.width + groupMetrics.groupInlineInset,
      ),
    );
    const bottom = Math.max(
      subgraph.y + subgraph.height,
      ...contents.map(
        (item) => item.y + item.height + groupMetrics.groupBlockInset,
      ),
    );
    subgraph.x = left;
    subgraph.y = top;
    subgraph.width = right - left;
    subgraph.height = bottom - top;
  };
  for (const root of childrenByParent.get("") ?? []) fit(root);
  return { ...model, subgraphs };
}

export function finalizeArchitectureProjectionOwnerGeometry(
  model: MermaidVisualModel,
) {
  return fitArchitectureOwnerGroupsToDirectChildren(model);
}
