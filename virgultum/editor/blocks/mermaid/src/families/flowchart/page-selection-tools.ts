// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidPageSelectionItem,
  MermaidPageSelectionToolsContribution,
} from "../runtime/contracts.js";
import { mermaidMessages } from "../../i18n.js";

export const mermaidFlowchartPageSelectionTools = {
  boxSelectableKinds: ["edge", "node", "subgraph"],
  containerAction: {
    eligibleKinds: ["node"],
    id: "flowchart.add-subgraph",
    label: () => mermaidMessages.visualAddSubgraph(),
    minimumSelectionCount: 2,
    validationMessage: (code) =>
      code === "flowchart.subgraph.same-parent"
        ? mermaidMessages.flowchartSubgraphSameParent()
        : code === "flowchart.subgraph.nodes-only"
          ? mermaidMessages.flowchartSubgraphNodesOnly()
          : mermaidMessages.flowchartSubgraphMinimum(),
    validate: ({ items, visualModel }) => {
      if (items.some((item) => item.kind !== "node")) {
        return { code: "flowchart.subgraph.nodes-only", valid: false };
      }
      const nodeItems = items.filter((item) => item.kind === "node");
      if (nodeItems.length < 2) {
        return { code: "flowchart.subgraph.minimum", valid: false };
      }
      const parents = new Set(
        nodeItems.map(
          (item) =>
            visualModel.subgraphs?.find((subgraph) =>
              subgraph.nodeIds.includes(item.editKey),
            )?.id ?? "",
        ),
      );
      return parents.size === 1
        ? { valid: true }
        : { code: "flowchart.subgraph.same-parent", valid: false };
    },
  },
  operations: {
    deleteSelection: true,
    duplicateSelection: true,
    moveSelection: true,
  },
  resolveItems: (visualModel): MermaidPageSelectionItem[] => [
    ...visualModel.nodes.map<MermaidPageSelectionItem>((node) => ({
      editKey: node.id,
      kind: "node",
    })),
    ...visualModel.edges.map<MermaidPageSelectionItem>((edge) => ({
      editKey: edge.id,
      kind: "edge",
    })),
    ...(visualModel.subgraphs ?? []).map<MermaidPageSelectionItem>(
      (subgraph) => ({
        editKey: subgraph.id,
        kind: "subgraph",
      }),
    ),
  ],
  selectableKinds: ["edge", "node", "subgraph"],
  selectAllKinds: ["node"],
} as const satisfies MermaidPageSelectionToolsContribution;
