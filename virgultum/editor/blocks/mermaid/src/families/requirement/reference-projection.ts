// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "../../engine/requirement/index.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";

export type RequirementReferenceMarker = {
  key: string;
  left: number;
  top: number;
  relationKeys: string[];
};

/** An unresolved relation has no connector. Its surviving endpoint (or the
 * diagram if neither endpoint exists) still owns a local repair control. */
export function requirementReferenceMarkers(
  model: MermaidRequirementModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): RequirementReferenceMarker[] {
  const groups = new Map<string, RequirementReferenceMarker>();
  for (const relation of model.relations) {
    if (
      !model.diagnostics?.some(
        (diagnostic) =>
          diagnostic.sourceKey === relation.sourceKey &&
          (diagnostic.code === "missing-reference" ||
            diagnostic.code === "ambiguous-reference"),
      )
    )
      continue;
    const node = [...model.requirements, ...model.elements].find(
      (node) => node.id === relation.fromId || node.id === relation.toId,
    );
    const anchor = node ? resolve("node", node.id) : resolve("diagram");
    if (!anchor || !relation.sourceKey) continue;
    const key = node?.sourceKey ?? "diagram",
      group = groups.get(key);
    if (group) group.relationKeys.push(relation.sourceKey);
    else
      groups.set(key, { key, ...anchor, relationKeys: [relation.sourceKey] });
  }
  return [...groups.values()];
}
