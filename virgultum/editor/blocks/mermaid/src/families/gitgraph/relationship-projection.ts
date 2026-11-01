// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../../engine/gitgraph/index.js";
import { orderedGitGraphBranches } from "../../engine/gitgraph/index.js";
import type { MermaidVisualEdge } from "../runtime/gfx-model.js";
import { gitGraphData } from "./gfx-data.js";
import { projectNeutralMermaidGfxConnectorElement } from "../runtime/gfx-element-projection-defaults.js";
import { gitGraphBranchColor } from "./commit-projection.js";
import { gitGraphBinding } from "./gfx-data.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
export function gitGraphRelationships(
  model: MermaidGitGraphModel,
): MermaidVisualEdge[] {
  const parents: MermaidVisualEdge[] = [
    ...(model.derivedGraph?.effectiveMap.values() ?? []),
  ].flatMap((c) =>
    c.parentReferences.flatMap((id, i) => {
      const parent = model.derivedGraph?.effectiveMap.get(id);
      return !parent || parent.sourceKey === c.sourceKey
        ? []
        : [
            {
              id: `${c.sourceKey}:parent:${i}`,
              source: parent.sourceKey,
              target: c.sourceKey,
              label: "",
              labelEditable: false,
              sourceMarker: "none" as const,
              targetMarker: "none" as const,
              linkType: "open" as const,
              style:
                c.kind === "cherry-pick" && i === 1
                  ? ("dotted" as const)
                  : ("solid" as const),
              connectorMode:
                parent.branchId === c.branchId
                  ? ("straight" as const)
                  : ("orthogonal" as const),
              sourcePosition:
                model.direction === "LR"
                  ? ([1, 0.5] as const)
                  : model.direction === "TB"
                    ? ([0.5, 1] as const)
                    : ([0.5, 0] as const),
              targetPosition:
                model.direction === "LR"
                  ? ([0, 0.5] as const)
                  : model.direction === "TB"
                    ? ([0.5, 0] as const)
                    : ([0.5, 1] as const),
              familyData: gitGraphData({
                role: "relationship",
                sourceKey: c.sourceKey,
                kind:
                  i === 0 ? "parent" : c.kind === "merge" ? "merge" : "cherry",
                parent: parent.sourceKey,
              }),
            },
          ];
    }),
  );
  const origins: MermaidVisualEdge[] = model.branches.flatMap((branch) => {
    const key = branch.sourceKey;
    const origin = model.derivedGraph?.contexts.find(
      (c) => c.sourceKey === key,
    )?.head;
    if (
      !key ||
      !origin ||
      ![...(model.derivedGraph?.effectiveMap.values() ?? [])].some(
        (c) => c.sourceKey === origin,
      )
    )
      return [];
    const parentBranch = model.derivedGraph?.occurrences.find(
      (c) => c.sourceKey === origin,
    )?.branchId;
    const ordered = orderedGitGraphBranches(model);
    const before =
      ordered.findIndex((b) => b.id === branch.id) <
      ordered.findIndex((b) => b.id === parentBranch);
    return [
      {
        id: `${key}:origin-edge`,
        source: origin,
        target: `${key}:origin`,
        label: "",
        labelEditable: false,
        sourceMarker: "none",
        targetMarker: "none",
        linkType: "open",
        style: "solid",
        connectorMode: "orthogonal",
        sourcePosition:
          model.direction === "LR"
            ? [1, 0.5]
            : model.direction === "TB"
              ? [0.5, 1]
              : [0.5, 0],
        targetPosition:
          model.direction === "LR"
            ? [0.5, before ? 1 : 0]
            : [before ? 1 : 0, 0.5],
        familyData: gitGraphData({
          role: "relationship",
          sourceKey: key,
          kind: "origin",
          parent: origin,
        }),
      },
    ];
  });
  return [...parents, ...origins];
}
export function projectGitGraphRelationship(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const branch = gitGraphBinding(
    model.nodes.find((n) => n.id === edge.target) ?? {},
  )?.branch;
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    stroke: gitGraphBranchColor(model, branch),
    routingObstacleKeys: model.nodes
      .filter(
        (n) =>
          n.id !== edge.source &&
          n.id !== edge.target &&
          ["commit", "id", "message", "tag"].includes(
            gitGraphBinding(n)?.role ?? "",
          ),
      )
      .map((n) => n.id),
    routingClearance: 8,
    routingCornerRadius: 8,
    strokeWidth: 2,
  };
}
