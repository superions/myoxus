// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages } from "../../i18n.js";

export const FLOWCHART_ACTION_IDS = {
  addNode: "mermaid-flowchart.add-node",
  addSubgraph: "mermaid-flowchart.add-subgraph",
  appearance: "mermaid-flowchart.appearance",
  comments: "mermaid-flowchart.comments",
  connect: "mermaid-flowchart.connect",
  deleteSelection: "e.delete",
  more: "mermaid-flowchart.more",
  shapes: "mermaid-flowchart.shapes",
} as const;

export type MermaidFlowchartActionId =
  (typeof FLOWCHART_ACTION_IDS)[keyof typeof FLOWCHART_ACTION_IDS];

export function flowchartActionLabels() {
  return {
    addNode: mermaidMessages.visualAddNode(),
    addSubgraph: mermaidMessages.visualAddSubgraph(),
    appearance: mermaidMessages.visualAppearance(),
    comments: mermaidMessages.visualComments(),
    connect: mermaidMessages.visualConnect(),
    deleteSelection: mermaidMessages.visualDelete(),
    more: mermaidMessages.visualMoreActions(),
    shapes: mermaidMessages.visualShapeMenu(),
  } as const;
}
