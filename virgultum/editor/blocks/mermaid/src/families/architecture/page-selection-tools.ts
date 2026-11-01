// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../i18n.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
import { architectureNodeGfxData } from "./gfx-data.js";

export const mermaidArchitecturePageSelectionTools = {
  boxSelectableKinds: ["node"],
  containerAction: {
    eligibleKinds: ["node"],
    id: "architecture.add-group",
    label: () => mermaidMessages.architectureAddGroup(),
    minimumSelectionCount: 2,
    validationMessage: (code) =>
      code === "architecture.group.same-parent"
        ? mermaidMessages.flowchartSubgraphSameParent()
        : code === "architecture.group.nodes-only"
          ? mermaidMessages.flowchartSubgraphNodesOnly()
          : mermaidMessages.flowchartSubgraphMinimum(),
    validate: ({ items, visualModel }) => {
      if (items.some((item) => item.kind !== "node")) {
        return { code: "architecture.group.nodes-only", valid: false };
      }
      if (items.length < 2) {
        return { code: "architecture.group.minimum", valid: false };
      }
      const selectedNodes = items.flatMap((item) => {
        const node = visualModel.nodes.find(
          (candidate) => candidate.id === item.editKey,
        );
        return node && architectureNodeGfxData(node) ? [node] : [];
      });
      if (selectedNodes.length !== items.length) {
        return { code: "architecture.group.nodes-only", valid: false };
      }
      const parentIds = new Set(
        selectedNodes.map(
          (node) => architectureNodeGfxData(node)?.groupId ?? "",
        ),
      );
      return parentIds.size === 1
        ? { valid: true }
        : { code: "architecture.group.same-parent", valid: false };
    },
  },
  operations: {
    deleteSelection: true,
    duplicateSelection: false,
    moveSelection: true,
  },
  resolveItems: (visualModel) => [
    ...visualModel.nodes.flatMap((node) =>
      architectureNodeGfxData(node)
        ? [{ editKey: node.id, kind: "node" as const }]
        : [],
    ),
    ...visualModel.edges.map((edge) => ({
      editKey: edge.id,
      kind: "edge" as const,
    })),
    ...(visualModel.subgraphs ?? []).map((subgraph) => ({
      editKey: subgraph.id,
      kind: "subgraph" as const,
    })),
  ],
  selectableKinds: ["edge", "node", "subgraph"],
  selectAllKinds: ["node"],
} as const satisfies MermaidPageSelectionToolsContribution;
