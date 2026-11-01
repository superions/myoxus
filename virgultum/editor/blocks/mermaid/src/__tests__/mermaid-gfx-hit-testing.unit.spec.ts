import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  findMermaidGfxEdgeIdByModelPoint,
  findMermaidGfxNodeIdByModelPoint,
  findMermaidGfxNodeIdFromNativeHits,
  findMermaidGfxNodeModelByModelPoint,
  findMermaidGfxNodeModelFromNativeHits,
  findMermaidGfxSubgraphHeaderIdByModelPoint,
  findMermaidGfxSubgraphIdByModelPoint,
  getMermaidGfxHitTestModels,
  findMermaidGfxSubgraphCollapseIdByModelPoint,
} from "../mermaid-gfx-hit-testing.js";

function createYMap(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string) => values.get(key),
  };
}

describe("Mermaid GFX hit testing", () => {
  test("retained hidden children/edges have no native or Page hits and collapse/header/background remain distinct", () => {
    const child = {
      type: "shape",
      hidden: true,
      xywh: new Bound(20, 60, 100, 60).serialize(),
      yMap: createYMap({
        mermaidRole: "mermaid-flowchart-node",
        mermaidNodeId: "api",
      }),
    };
    const header = {
      type: "shape",
      xywh: new Bound(0, 0, 200, 140).serialize(),
      yMap: createYMap({
        mermaidRole: "mermaid-flowchart-subgraph",
        mermaidSubgraphId: "team",
        mermaidSubgraphCollapsible: true,
        mermaidSubgraphCollapseControlSize: 32,
        mermaidSubgraphHeaderHeight: 50,
      }),
    };
    const hiddenGroup = { ...header, hidden: true };
    expect(findMermaidGfxNodeIdFromNativeHits([child])).toBe("");
    expect(findMermaidGfxNodeIdByModelPoint([child], 30, 70)).toBe("");
    expect(findMermaidGfxSubgraphIdByModelPoint([hiddenGroup], 30, 70)).toBe(
      "",
    );
    expect(
      findMermaidGfxSubgraphHeaderIdByModelPoint([hiddenGroup], 30, 20),
    ).toBe("");
    expect(findMermaidGfxSubgraphHeaderIdByModelPoint([header], 30, 20)).toBe(
      "team",
    );
    expect(findMermaidGfxSubgraphHeaderIdByModelPoint([header], 190, 20)).toBe(
      "",
    );
    expect(
      findMermaidGfxSubgraphCollapseIdByModelPoint([header], 190, 20),
    ).toBe("team");
    expect(findMermaidGfxSubgraphCollapseIdByModelPoint([header], 30, 70)).toBe(
      "",
    );
    expect(findMermaidGfxSubgraphIdByModelPoint([header], 30, 70)).toBe("team");
    expect(
      findMermaidGfxEdgeIdByModelPoint({
        connectors: [
          {
            hidden: true,
            type: "connector",
            absolutePath: [
              [20, 90],
              [120, 90],
            ],
            includesPoint: () => true,
            yMap: createYMap({
              mermaidRole: "mermaid-flowchart-edge",
              mermaidEdgeId: "internal",
            }),
          },
        ],
        edges: [{ id: "internal", source: "api", target: "db" }],
        nodes: [
          { id: "api", xywh: "[0,60,20,60]" },
          { id: "db", xywh: "[120,60,20,60]" },
        ],
        x: 60,
        y: 90,
      }),
    ).toBe("");
  });
  test("materializes owner children in top-first hit-test order", () => {
    const models = new Map<string, unknown>([
      ["bottom", { id: "gfx-bottom" }],
      ["middle", { id: "gfx-middle" }],
      ["top", { id: "gfx-top" }],
    ]);

    expect(
      getMermaidGfxHitTestModels({
        elementIds: ["bottom", "middle", "top"],
        getModel: (id) => models.get(id),
      }),
    ).toEqual([{ id: "gfx-top" }, { id: "gfx-middle" }, { id: "gfx-bottom" }]);
  });

  test("returns the first matching node id using expanded shape bounds", () => {
    const bottomNode = {
      type: "shape",
      xywh: new Bound(0, 0, 100, 60).serialize(),
      yMap: createYMap({
        mermaidNodeId: "bottom",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };
    const topNode = {
      type: "shape",
      xywh: new Bound(20, 20, 100, 60).serialize(),
      yMap: createYMap({
        mermaidNodeId: "top",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };

    expect(
      findMermaidGfxNodeIdByModelPoint([topNode, bottomNode], 25, 25),
    ).toBe("top");
    expect(
      findMermaidGfxNodeModelByModelPoint([topNode, bottomNode], 25, 25),
    ).toBe(topNode);
    expect(findMermaidGfxNodeIdByModelPoint([bottomNode], -8, 30)).toBe(
      "bottom",
    );
    expect(findMermaidGfxNodeIdByModelPoint([bottomNode], -20, 30)).toBe("");
  });

  test("returns the top-most Mermaid node id from native GFX hit results", () => {
    const bottomNode = {
      type: "shape",
      yMap: createYMap({
        mermaidNodeId: "bottom",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };
    const topNode = {
      type: "shape",
      yMap: createYMap({
        mermaidNodeId: "top",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };
    const edge = {
      type: "connector",
      yMap: createYMap({
        mermaidEdgeId: "edge-A-B",
        mermaidRole: "mermaid-flowchart-edge",
      }),
    };

    expect(
      findMermaidGfxNodeIdFromNativeHits([bottomNode, edge, topNode]),
    ).toBe("top");
    expect(
      findMermaidGfxNodeModelFromNativeHits([bottomNode, edge, topNode]),
    ).toBe(topNode);
    expect(findMermaidGfxNodeIdFromNativeHits(bottomNode)).toBe("bottom");
    expect(findMermaidGfxNodeIdFromNativeHits(edge)).toBe("");
    expect(findMermaidGfxNodeIdFromNativeHits(null)).toBe("");
  });

  test("skips non-interactive State/Sequence helper nodes during hit testing", () => {
    const participant = {
      type: "shape",
      xywh: new Bound(0, 0, 120, 64).serialize(),
      yMap: createYMap({
        mermaidNodeId: "API",
        mermaidNodeDenseLabel: true,
        mermaidRole: "mermaid-flowchart-node",
      }),
    };
    const activation = {
      type: "shape",
      xywh: new Bound(20, 0, 18, 64).serialize(),
      yMap: createYMap({
        mermaidNodeId: "activate-API-2",
        mermaidNodeDenseLabel: true,
        mermaidNodeSelectable: false,
        mermaidRole: "mermaid-flowchart-node",
      }),
    };

    expect(findMermaidGfxNodeIdFromNativeHits([participant, activation])).toBe(
      "API",
    );
    expect(
      findMermaidGfxNodeIdByModelPoint([activation, participant], 25, 30),
    ).toBe("API");
  });

  test("prefers a labeled State node over an overlapping start marker", () => {
    const state = {
      type: "shape",
      xywh: new Bound(0, 0, 180, 76).serialize(),
      yMap: createYMap({
        mermaidNodeDisplayLabel: "Memory Access",
        mermaidNodeDenseLabel: true,
        mermaidNodeId: "Memory",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };
    const startMarker = {
      type: "shape",
      xywh: new Bound(70, 18, 38, 38).serialize(),
      yMap: createYMap({
        mermaidNodeDisplayLabel: "",
        mermaidNodeDenseLabel: true,
        mermaidNodeId: "Active::r1::__start__",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };

    expect(findMermaidGfxNodeIdFromNativeHits([state, startMarker])).toBe(
      "Memory",
    );
    expect(findMermaidGfxNodeIdByModelPoint([startMarker, state], 90, 38)).toBe(
      "Memory",
    );
  });

  test("returns subgraph ids for body and header hit zones", () => {
    const subgraph = {
      type: "shape",
      xywh: new Bound(100, 80, 240, 160).serialize(),
      yMap: createYMap({
        mermaidRole: "mermaid-flowchart-subgraph",
        mermaidSubgraphId: "cluster",
      }),
    };
    const node = {
      type: "shape",
      xywh: new Bound(110, 100, 120, 64).serialize(),
      yMap: createYMap({
        mermaidNodeId: "A",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };

    expect(
      findMermaidGfxSubgraphIdByModelPoint([node, subgraph], 96, 100),
    ).toBe("cluster");
    expect(
      findMermaidGfxSubgraphHeaderIdByModelPoint([node, subgraph], 120, 100),
    ).toBe("cluster");
    expect(
      findMermaidGfxSubgraphHeaderIdByModelPoint([node, subgraph], 120, 180),
    ).toBe("");
  });

  test("prioritizes the smallest nested subgraph hit surface", () => {
    const subgraph = (id: string, bound: Bound) => ({
      type: "shape",
      xywh: bound.serialize(),
      yMap: createYMap({
        mermaidRole: "mermaid-flowchart-subgraph",
        mermaidSubgraphId: id,
      }),
    });
    const parent = subgraph("parent", new Bound(40, 40, 500, 500));
    const child = subgraph("child", new Bound(120, 120, 220, 220));

    expect(
      findMermaidGfxSubgraphIdByModelPoint([parent, child], 160, 160),
    ).toBe("child");
    expect(
      findMermaidGfxSubgraphHeaderIdByModelPoint([parent, child], 160, 130),
    ).toBe("child");
  });

  test("returns the nearest edge id while protecting node hit zones and endpoints", () => {
    const nodes = [
      { id: "A", xywh: new Bound(0, 0, 100, 60).serialize() },
      { id: "B", xywh: new Bound(300, 0, 100, 60).serialize() },
      { id: "C", xywh: new Bound(300, 160, 100, 60).serialize() },
    ];
    const edges = [
      { id: "edge-A-B", source: "A", target: "B" },
      { id: "edge-A-C", source: "A", target: "C" },
    ];

    expect(
      findMermaidGfxEdgeIdByModelPoint({
        edges,
        nodes,
        x: 200,
        y: 32,
      }),
    ).toBe("edge-A-B");
    expect(
      findMermaidGfxEdgeIdByModelPoint({
        edges,
        nodes,
        x: 50,
        y: 30,
      }),
    ).toBe("");

    expect(
      findMermaidGfxEdgeIdByModelPoint({
        edges: [{ id: "edge-small-A-B", source: "small-A", target: "small-B" }],
        nodes: [
          { id: "small-A", xywh: new Bound(0, 0, 10, 10).serialize() },
          { id: "small-B", xywh: new Bound(300, 0, 10, 10).serialize() },
        ],
        x: 50,
        y: 5,
      }),
    ).toBe("");

    expect(
      findMermaidGfxEdgeIdByModelPoint({
        edges: [
          {
            id: "edge-touching-A-B",
            source: "touching-A",
            target: "touching-B",
          },
        ],
        nodes: [
          { id: "touching-A", xywh: new Bound(0, 0, 100, 60).serialize() },
          { id: "touching-B", xywh: new Bound(100, 0, 100, 60).serialize() },
        ],
        x: 100,
        y: 30,
      }),
    ).toBe("edge-touching-A-B");
  });
});
