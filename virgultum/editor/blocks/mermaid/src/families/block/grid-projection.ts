// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidBlockDiagramModel,
  MermaidBlockNode,
} from "../../engine/block/index.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { blockProjectionBinding } from "./gfx-data.js";
export function blockStyles(
  model: MermaidBlockDiagramModel,
  node: MermaidBlockNode,
) {
  const values: Record<string, string> = {};
  // Native definitions are available independent of statement position; inline
  // assignments are the last exact-ID style resolved by BlockDB.
  for (const definition of model.styleStatements.filter(
    (s) =>
      s.kind === "classDef" &&
      (s.targets === "default" || node.classes.includes(s.targets)),
  )) {
    for (const item of definition.value.split(/,(?![^()]*\))/)) {
      const colon = item.indexOf(":");
      if (colon >= 0)
        values[item.slice(0, colon).trim()] = item.slice(colon + 1).trim();
    }
  }
  for (const item of node.styles.join(",").split(/,(?![^()]*\))/)) {
    const colon = item.indexOf(":");
    if (colon >= 0)
      values[item.slice(0, colon).trim()] = item.slice(colon + 1).trim();
  }
  return values;
}
export function blockTypography(styles: Readonly<Record<string, string>>) {
  const base = resolveMermaidGfxProjectionTheme().typography,
    projection = projectMermaidSourceStyle(styles),
    fontSize = projection.fontSize ?? base.fontSize;
  return {
    ...base,
    fontSize,
    lineHeight: (base.lineHeight * fontSize) / base.fontSize,
    fontFamily: projection.fontFamily ?? base.fontFamily,
    fontStyle: projection.fontStyle ?? base.fontStyle,
    fontWeight: projection.fontWeight ?? base.fontWeight,
  };
}
export function blockAlignmentGuides(model: MermaidVisualModel) {
  const groups = new Map<
    string,
    { direction: "row" | "column"; id: string; members: string[] }
  >();
  for (const node of model.nodes) {
    const b = blockProjectionBinding(node);
    if (!b) continue;
    const data = node.familyData?.payload;
    for (const direction of ["row", "column"] as const) {
      const slot = data?.[direction];
      if (typeof slot !== "number") continue;
      const id = `${b.parentKey ?? "root"}:${direction}:${slot}`;
      const group = groups.get(id) ?? { direction, id, members: [] };
      group.members.push(node.id);
      groups.set(id, group);
    }
  }
  return [...groups.values()];
}
