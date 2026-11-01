import { describe, expect, test } from "vitest";

import {
  findMermaidGfxEdgeModelByVisualId,
  findMermaidGfxNodeModelByVisualId,
  findMermaidGfxSubgraphModelByVisualId,
  getMermaidGfxSelectedElementIds,
  getMermaidGfxSelectionIdentity,
  resolveMermaidGfxProjectionOwnerSelectionIntent,
  shouldPreserveMermaidGfxNodeSelectionForManagedSubgraph,
} from "../mermaid-gfx-selection.js";

function createYMap(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string) => values.get(key),
  };
}

describe("Mermaid GFX selection identity", () => {
  test("classifies node, edge and subgraph identities through shared metadata", () => {
    expect(
      getMermaidGfxSelectionIdentity({
        props: {
          mermaidNodeId: "props-node",
        },
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "A",
          mermaidRole: "mermaid-flowchart-node",
        }),
      }),
    ).toMatchObject({
      edgeId: "",
      isEdgeConnector: false,
      isNodeShape: true,
      isSubgraphShape: false,
      nodeId: "A",
      subgraphId: "",
      type: "shape",
    });

    expect(
      getMermaidGfxSelectionIdentity({
        props: {
          mermaidEdgeId: "props-edge",
          type: "connector",
        },
        yMap: createYMap({
          mermaidEdgeId: "edge-A-B",
          mermaidRole: "mermaid-flowchart-edge",
        }),
      }),
    ).toMatchObject({
      edgeId: "edge-A-B",
      isEdgeConnector: true,
      isNodeShape: false,
      isSubgraphShape: false,
      type: "connector",
    });

    expect(
      getMermaidGfxSelectionIdentity({
        props: {
          mermaidNodeId: "cluster-node-props",
        },
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "cluster-node",
          mermaidRole: "mermaid-flowchart-subgraph",
          mermaidSubgraphId: "cluster",
        }),
      }),
    ).toMatchObject({
      isNodeShape: false,
      isSubgraphShape: true,
      nodeId: "cluster-node",
      subgraphId: "cluster",
      type: "shape",
    });
  });

  test("extracts scoped GFX selection ids from controller state", () => {
    expect(
      getMermaidGfxSelectedElementIds({
        selectedElements: [{ id: "edge-A-B" }, {}, { id: "node-B" }],
        selectedIds: ["node-A"],
      }),
    ).toEqual(["node-A", "edge-A-B", "node-B"]);
    expect(getMermaidGfxSelectedElementIds(null)).toEqual([]);
  });

  test("keeps visible State/Sequence helper shapes out of node selection", () => {
    expect(
      getMermaidGfxSelectionIdentity({
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "activate-API-2",
          mermaidNodeSelectable: false,
          mermaidRole: "mermaid-flowchart-node",
        }),
      }),
    ).toMatchObject({
      isNodeShape: false,
      nodeId: "activate-API-2",
    });
    expect(
      getMermaidGfxSelectionIdentity({
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "note-3",
          mermaidNodeSelectable: true,
          mermaidRole: "mermaid-flowchart-node",
        }),
      }),
    ).toMatchObject({
      isNodeShape: true,
      nodeId: "note-3",
    });
  });

  test("maps Relationship detail-row shapes back to their owning node", () => {
    expect(
      getMermaidGfxSelectionIdentity({
        type: "shape",
        yMap: createYMap({
          mermaidDetailId: "class-member-Document-1",
          mermaidDetailOwnerNodeId: "Document",
          mermaidRole: "mermaid-relationship-detail",
        }),
      }),
    ).toMatchObject({
      isNodeShape: true,
      isSubgraphShape: false,
      nodeId: "Document",
      type: "shape",
    });
  });

  test("finds node, edge and subgraph models by visual ids in owner projection order", () => {
    const models = {
      edge: {
        id: "gfx-edge",
        type: "connector",
        yMap: createYMap({
          mermaidEdgeId: "edge-A-B",
        }),
      },
      nodeA: {
        id: "gfx-node-a",
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "A",
        }),
      },
      nodeB: {
        id: "gfx-node-b",
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "B",
        }),
      },
      sequenceAnchor: {
        id: "gfx-sequence-anchor",
        type: "shape",
        yMap: createYMap({
          mermaidNodeId: "message-User-API-1-source",
          mermaidNodeSelectable: false,
        }),
      },
      subgraph: {
        id: "gfx-subgraph",
        type: "shape",
        yMap: createYMap({
          mermaidRole: "mermaid-flowchart-subgraph",
          mermaidSubgraphId: "cluster",
        }),
      },
    };
    const cardinalityLabel = {
      type: "shape",
      yMap: createYMap({ mermaidEdgeId: "edge-A-B" }),
    };
    expect(getMermaidGfxSelectionIdentity(cardinalityLabel)?.edgeId).toBe(
      "edge-A-B",
    );
    const byId = new Map<string, unknown>([
      ["cardinality-label", cardinalityLabel],
      ["edge", models.edge],
      ["node-a", models.nodeA],
      ["node-b", models.nodeB],
      ["sequence-anchor", models.sequenceAnchor],
      ["subgraph", models.subgraph],
    ]);
    const getModel = (id: string) => byId.get(id);
    const elementIds = [
      "cardinality-label",
      "edge",
      "node-a",
      "subgraph",
      "sequence-anchor",
      "node-b",
    ];

    expect(
      findMermaidGfxNodeModelByVisualId({
        elementIds,
        getModel,
        nodeId: "B",
      }),
    ).toBe(models.nodeB);
    expect(
      findMermaidGfxEdgeModelByVisualId({
        edgeId: "edge-A-B",
        elementIds,
        getModel,
      }),
    ).toBe(models.edge);
    expect(
      findMermaidGfxSubgraphModelByVisualId({
        elementIds,
        getModel,
        subgraphId: "cluster",
      }),
    ).toBe(models.subgraph);
    expect(
      findMermaidGfxNodeModelByVisualId({
        elementIds,
        getModel,
        includeHelperNodes: true,
        nodeId: "message-User-API-1-source",
      }),
    ).toBe(models.sequenceAnchor);
    expect(
      findMermaidGfxNodeModelByVisualId({
        elementIds,
        getModel,
        nodeId: "message-User-API-1-source",
      }),
    ).toBeNull();
    expect(
      findMermaidGfxNodeModelByVisualId({
        elementIds,
        getModel,
        nodeId: "missing",
      }),
    ).toBeNull();
  });

  test("resolves owner selection intent without losing legacy shape semantics", () => {
    const nodeA = {
      type: "shape",
      yMap: createYMap({ mermaidNodeId: "A" }),
    };
    const nodeB = {
      type: "shape",
      yMap: createYMap({ mermaidNodeId: "B" }),
    };
    const nodeC = {
      type: "shape",
      yMap: createYMap({ mermaidNodeId: "C" }),
    };
    const subgraph = {
      type: "shape",
      yMap: createYMap({
        mermaidRole: "mermaid-flowchart-subgraph",
        mermaidSubgraphId: "cluster",
      }),
    };
    const edge = {
      type: "connector",
      yMap: createYMap({ mermaidEdgeId: "edge-A-B" }),
    };
    const shapeWithoutNodeId = {
      type: "shape",
      yMap: createYMap(),
    };

    expect(
      resolveMermaidGfxProjectionOwnerSelectionIntent([nodeA, nodeB, nodeC]),
    ).toEqual({
      kind: "nodes",
      nodeIds: ["A", "B", "C"],
    });
    expect(resolveMermaidGfxProjectionOwnerSelectionIntent([subgraph])).toEqual(
      {
        kind: "subgraph",
        model: subgraph,
        subgraphId: "cluster",
      },
    );
    expect(resolveMermaidGfxProjectionOwnerSelectionIntent([nodeA])).toEqual({
      kind: "node",
      model: nodeA,
      nodeId: "A",
    });
    expect(resolveMermaidGfxProjectionOwnerSelectionIntent([edge])).toEqual({
      edgeId: "edge-A-B",
      kind: "edge",
      model: edge,
    });
    expect(
      resolveMermaidGfxProjectionOwnerSelectionIntent([shapeWithoutNodeId]),
    ).toEqual({ kind: "none" });
    expect(resolveMermaidGfxProjectionOwnerSelectionIntent([])).toEqual({
      kind: "none",
    });
  });

  test("keeps native group selection from replacing an explicit child node selection", () => {
    expect(
      shouldPreserveMermaidGfxNodeSelectionForManagedSubgraph({
        selectedNodeId: "task-a",
        subgraphId: "section-work",
        subgraphs: [
          { id: "section-work", nodeIds: ["task-a", "task-b"] },
          { id: "section-review", nodeIds: ["task-c"] },
        ],
      }),
    ).toBe(true);
    expect(
      shouldPreserveMermaidGfxNodeSelectionForManagedSubgraph({
        selectedNodeId: "task-a",
        subgraphId: "section-review",
        subgraphs: [
          { id: "section-work", nodeIds: ["task-a", "task-b"] },
          { id: "section-review", nodeIds: ["task-c"] },
        ],
      }),
    ).toBe(false);
    expect(
      shouldPreserveMermaidGfxNodeSelectionForManagedSubgraph({
        selectedNodeId: "",
        subgraphId: "section-work",
        subgraphs: [{ id: "section-work", nodeIds: ["task-a"] }],
      }),
    ).toBe(false);
  });
});
