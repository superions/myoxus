// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidClassModel } from "../../engine/class/index.js";
import type {
  MermaidVisualNode,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { classProjectionBinding } from "./gfx-data.js";
export function classNamespaceProjection(
  model: MermaidClassModel,
  nodes: MermaidVisualNode[],
  hierarchical: boolean,
): MermaidVisualSubgraph[] {
  const ids = new Map(model.namespaces.map((n) => [n.id, n.sourceKey]));
  return model.namespaces
    .filter((n) => hierarchical || n.explicit)
    .map((namespace, index) => {
      const children = nodes.filter((node) => {
        const id = classProjectionBinding(node)?.namespaceId;
        return (
          id === namespace.id ||
          (hierarchical && id?.startsWith(`${namespace.id}.`))
        );
      });
      const left = children.length
          ? Math.min(...children.map((n) => n.x)) - 24
          : 48 + index * 280,
        top = children.length ? Math.min(...children.map((n) => n.y)) - 48 : 48;
      const right = children.length
          ? Math.max(...children.map((n) => n.x + n.width)) + 24
          : left + 240,
        bottom = children.length
          ? Math.max(...children.map((n) => n.y + n.height)) + 24
          : top + 140;
      return {
        id: namespace.sourceKey,
        title: hierarchical ? namespace.label : namespace.id,
        parentId:
          hierarchical && namespace.parentId
            ? ids.get(namespace.parentId)
            : undefined,
        nodeIds: children.map((n) => n.id),
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        familyData: createMermaidVisualFamilyData("class", {
          kind: "namespace",
          sourceKey: namespace.sourceKey,
          sourceId: namespace.id,
        }),
      };
    });
}
