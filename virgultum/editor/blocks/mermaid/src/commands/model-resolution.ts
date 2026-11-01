import { parseMermaidVisualFamilyData } from "../families/runtime/gfx-family-data.js";
import { readTypeOwnedMermaidSourceProjection } from "../families/runtime/gfx-owner-hooks.js";
import type { MermaidBlockModel } from "@virgultum/model";

import { parseMermaidSourceToGfxVisualModel } from "../mermaid-gfx-graph-adapters.js";
import { getMermaidBlockSource } from "../utils.js";
import { resolveMermaidEffectiveBlockTitle } from "../mermaid-title-projection.js";

export function getMermaidVisualModel(model: MermaidBlockModel) {
  const source = getMermaidBlockSource(model.props);
  const parsed = parseMermaidSourceToGfxVisualModel(source).model;
  const familyData = parseMermaidVisualFamilyData(model.props.familyData);
  const visualModel =
    parsed && familyData
      ? readTypeOwnedMermaidSourceProjection(source, { ...parsed, familyData })
      : parsed;
  if (visualModel)
    visualModel.diagramTitle = resolveMermaidEffectiveBlockTitle(model.props);
  return visualModel;
}
