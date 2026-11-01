// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { mermaidMessages } from "../../i18n.js";
import type { MermaidGfxInspector } from "../runtime/editor-capabilities.js";
import type { MermaidArchitectureGfxControl } from "./control-contract.js";
import {
  architectureEdgeGfxData,
  architectureGroupIdForVisualNode,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";

type ArchitectureProperty = {
  readonly control: MermaidArchitectureGfxControl;
  readonly label: string;
  readonly options?: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
  readonly value: string;
};

export function architecturePropertyFields(
  visualModel: MermaidVisualModel,
  inspector: MermaidGfxInspector,
) {
  const fields: ArchitectureProperty[] = [];
  const node = inspector.selectedNode;
  const edge = inspector.selectedEdge;
  const subgraph = inspector.selectedSubgraph;
  const subgraphs = visualModel.subgraphs ?? [];
  const groupOption = (candidate: (typeof subgraphs)[number]) => ({
    label:
      architectureSubgraphGfxData(candidate)?.label ||
      candidate.title.split("\n")[0] ||
      candidate.id,
    value: candidate.id,
  });
  const rootOption = {
    label: mermaidMessages.chartRoot(),
    value: "",
  };
  if (node) {
    const architectureNode = architectureNodeGfxData(node);
    fields.push(
      {
        control: "architectureNodeId",
        label: mermaidMessages.architectureObjectId(),
        value: node.id,
      },
      {
        control: "architectureNodeKind",
        label: mermaidMessages.selectedArchitectureNodeKind(),
        options: [
          { label: mermaidMessages.architectureService(), value: "service" },
          {
            label: mermaidMessages.architectureJunction(),
            value: "junction",
          },
        ],
        value: architectureNode?.kind ?? "service",
      },
      {
        control: "architectureNodeGroup",
        label: mermaidMessages.chartParent(),
        options: [rootOption, ...subgraphs.map(groupOption)],
        value: architectureNode?.groupId ?? "",
      },
    );
    if (architectureNode?.kind !== "junction" && node.labelEditable !== false) {
      fields.push(
        {
          control: "architectureServiceIconKind",
          label: mermaidMessages.selectedArchitectureServiceIconKind(),
          options: [
            {
              label: mermaidMessages.architectureNoIcon(),
              value: "none",
            },
            { label: mermaidMessages.architectureIcon(), value: "icon" },
            {
              label: mermaidMessages.architectureTextIcon(),
              value: "text",
            },
          ],
          value: architectureNode?.iconKind ?? "none",
        },
        {
          control: "architectureServiceIcon",
          label: mermaidMessages.selectedArchitectureServiceIcon(),
          value: architectureNode?.icon ?? "",
        },
      );
    }
  }
  if (edge) {
    const architecture = architectureEdgeGfxData(edge);
    const groupEndpointAvailable = (nodeId: string, otherNodeId: string) => {
      const endpoint = visualModel.nodes.find((node) => node.id === nodeId);
      if (!endpoint || !architectureNodeGfxData(endpoint)) return false;
      const groupId = architectureGroupIdForVisualNode(visualModel, nodeId);
      const otherGroupId = architectureGroupIdForVisualNode(
        visualModel,
        otherNodeId,
      );
      return Boolean(groupId) && groupId !== otherGroupId;
    };
    const sourceGroupAvailable = groupEndpointAvailable(
      edge.source,
      edge.target,
    );
    const targetGroupAvailable = groupEndpointAvailable(
      edge.target,
      edge.source,
    );
    const ports = ["L", "R", "T", "B"].map((value) => ({
      label: value,
      value,
    }));
    const markerOptions = (available: boolean) => [
      { label: mermaidMessages.architectureEndpointObject(), value: "object" },
      ...(available
        ? [
            {
              label: mermaidMessages.architectureEndpointGroup(),
              value: "group",
            },
          ]
        : []),
    ];
    fields.push(
      {
        control: "edgeLabel",
        label: mermaidMessages.selectedEdgeLabel(),
        value: edge.label,
      },
      {
        control: "architectureFromPort",
        label: mermaidMessages.selectedArchitectureFromPort(),
        options: ports,
        value: architecture?.fromPort ?? "R",
      },
      {
        control: "architectureToPort",
        label: mermaidMessages.selectedArchitectureToPort(),
        options: ports,
        value: architecture?.toPort ?? "L",
      },
      {
        control: "architectureFromArrow",
        label: mermaidMessages.architectureSourceArrowhead(),
        options: [
          { label: "—", value: "none" },
          { label: "←", value: "arrow" },
        ],
        value: architecture?.fromArrow ? "arrow" : "none",
      },
      {
        control: "architectureToArrow",
        label: mermaidMessages.architectureTargetArrowhead(),
        options: [
          { label: "—", value: "none" },
          { label: "→", value: "arrow" },
        ],
        value: architecture?.toArrow === false ? "none" : "arrow",
      },
      {
        control: "architectureFromGroup",
        label: mermaidMessages.architectureSourceEndpoint(),
        options: markerOptions(sourceGroupAvailable),
        value: architecture?.fromGroup ? "group" : "object",
      },
      {
        control: "architectureToGroup",
        label: mermaidMessages.architectureTargetEndpoint(),
        options: markerOptions(targetGroupAvailable),
        value: architecture?.toGroup ? "group" : "object",
      },
    );
  }
  if (subgraph) {
    const descendantIds = new Set<string>();
    const collectDescendants = (parentId: string) => {
      for (const candidate of subgraphs) {
        if (architectureSubgraphGfxData(candidate)?.parentId !== parentId) {
          continue;
        }
        if (descendantIds.has(candidate.id)) continue;
        descendantIds.add(candidate.id);
        collectDescendants(candidate.id);
      }
    };
    collectDescendants(subgraph.id);
    fields.push(
      {
        control: "architectureGroupId",
        label: mermaidMessages.architectureObjectId(),
        value: subgraph.id,
      },
      {
        control: "architectureGroupParent",
        label: mermaidMessages.chartParent(),
        options: [
          rootOption,
          ...subgraphs
            .filter(
              (candidate) =>
                candidate.id !== subgraph.id &&
                !descendantIds.has(candidate.id),
            )
            .map(groupOption),
        ],
        value: architectureSubgraphGfxData(subgraph)?.parentId ?? "",
      },
      {
        control: "architectureGroupIcon",
        label: mermaidMessages.selectedArchitectureGroupIcon(),
        value: architectureSubgraphGfxData(subgraph)?.icon ?? "",
      },
    );
  }
  return fields;
}
