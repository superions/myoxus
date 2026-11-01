// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidErModel } from "../../engine/er/index.js";
import type {
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { erSubgraphHeaderMetrics } from "./layout.js";
/** Inner groups are measured first; an outer frame encloses both cards and
 * child frames without intercepting their content hit areas. */
export function erSubgraphProjection(
  model: MermaidErModel,
  nodes: MermaidVisualNode[],
  styles: (id: string) => Readonly<Record<string, string>>,
  frames?: ReadonlyMap<
    string,
    { x: number; y: number; width: number; height: number }
  >,
): MermaidVisualSubgraph[] {
  const result: MermaidVisualSubgraph[] = [],
    ids = new Map(model.subgraphs.map((g) => [g.id, g.sourceKey]));
  for (const group of [...model.subgraphs].reverse()) {
    const nodeIds = model.entities
        .filter((e) => group.members.includes(e.id))
        .map((e) => e.sourceKey),
      children = [
        ...nodes.filter((n) => nodeIds.includes(n.id)),
        ...result.filter((g) => g.parentId === group.sourceKey),
      ];
    const left = children.length
        ? Math.min(...children.map((n) => n.x)) - 24
        : 48 + group.order * 280,
      top = children.length
        ? Math.min(...children.map((n) => n.y)) -
          erSubgraphHeaderMetrics(group.label, styles(group.id)).height
        : 48,
      right = children.length
        ? Math.max(...children.map((n) => n.x + n.width)) + 24
        : left + 240,
      bottom = children.length
        ? Math.max(...children.map((n) => n.y + n.height)) + 24
        : top + 140;
    result.push({
      id: group.sourceKey,
      title: group.label,
      displayLabel: group.direction
        ? `${group.label} · ${group.direction}`
        : group.label,
      direction: group.direction,
      parentId: group.parentId ? ids.get(group.parentId) : undefined,
      nodeIds,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      ...frames?.get(group.sourceKey),
      familyData: createMermaidVisualFamilyData("er", {
        kind: "subgraph",
        sourceKey: group.sourceKey,
        sourceId: group.id,
        styles: styles(group.id),
      }),
    });
  }
  return result.reverse();
}
