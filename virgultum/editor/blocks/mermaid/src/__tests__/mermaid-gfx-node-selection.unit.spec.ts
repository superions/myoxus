import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  findNearestMermaidGfxNodeInDirection,
  mermaidGfxDirectionFromArrowKey,
  mermaidGfxNodeCenter,
  nextMermaidGfxSelectedNodeOrder,
  rememberMermaidGfxExplicitNodeSelection,
} from "../mermaid-gfx-node-selection.js";

describe("Mermaid GFX node selection order", () => {
  test("keeps a normal click single and leaves pair authority to explicit selection", () => {
    expect(
      nextMermaidGfxSelectedNodeOrder(
        {
          explicitOrder: [],
          lastExplicitNodeId: "",
          selectedNodeId: "A",
          selectedOrder: [],
        },
        "B",
      ),
    ).toEqual(["B"]);

    expect(
      nextMermaidGfxSelectedNodeOrder(
        {
          explicitOrder: ["A"],
          lastExplicitNodeId: "A",
          selectedNodeId: "",
          selectedOrder: [],
        },
        "B",
      ),
    ).toEqual(["B"]);
  });

  test("keeps additive multiselection ordered and unique", () => {
    expect(
      nextMermaidGfxSelectedNodeOrder(
        {
          explicitOrder: [],
          lastExplicitNodeId: "",
          selectedNodeId: "",
          selectedOrder: ["A", "B"],
        },
        "C",
        true,
      ),
    ).toEqual(["A", "B", "C"]);

    expect(
      nextMermaidGfxSelectedNodeOrder(
        {
          explicitOrder: [],
          lastExplicitNodeId: "",
          selectedNodeId: "",
          selectedOrder: ["A", "B"],
        },
        "A",
        true,
      ),
    ).toEqual(["B"]);
  });

  test("remembers explicit context-menu selection for directed connect actions", () => {
    expect(
      rememberMermaidGfxExplicitNodeSelection(
        {
          explicitOrder: ["A"],
          lastExplicitNodeId: "A",
          selectedNodeId: "",
          selectedOrder: ["A"],
        },
        "B",
        true,
      ),
    ).toEqual({
      explicitOrder: ["A", "B"],
      lastExplicitNodeId: "B",
      selectedOrder: ["A", "B"],
    });

    expect(
      rememberMermaidGfxExplicitNodeSelection(
        {
          explicitOrder: ["A", "B"],
          lastExplicitNodeId: "B",
          selectedNodeId: "",
          selectedOrder: ["A", "B"],
        },
        "B",
      ),
    ).toEqual({
      explicitOrder: ["A", "B"],
      lastExplicitNodeId: "B",
      selectedOrder: ["A", "B"],
      unchanged: true,
    });
  });

  test("deduplicates the pointerdown and click events of a single-node selection", () => {
    expect(
      rememberMermaidGfxExplicitNodeSelection(
        {
          explicitOrder: ["B"],
          lastExplicitNodeId: "B",
          selectedNodeId: "B",
          selectedOrder: ["B"],
        },
        "B",
      ),
    ).toEqual({
      explicitOrder: ["B"],
      lastExplicitNodeId: "B",
      selectedOrder: ["B"],
      unchanged: true,
    });
  });

  test("ignores empty node ids without mutating selection state", () => {
    expect(
      rememberMermaidGfxExplicitNodeSelection(
        {
          explicitOrder: ["A"],
          lastExplicitNodeId: "A",
          selectedNodeId: "A",
          selectedOrder: ["A"],
        },
        "",
      ),
    ).toEqual({
      explicitOrder: ["A"],
      lastExplicitNodeId: "A",
      selectedOrder: ["A"],
      unchanged: true,
    });
  });

  test("maps keyboard arrows to GFX navigation directions", () => {
    expect(mermaidGfxDirectionFromArrowKey("ArrowRight")).toBe("right");
    expect(mermaidGfxDirectionFromArrowKey("ArrowLeft")).toBe("left");
    expect(mermaidGfxDirectionFromArrowKey("ArrowDown")).toBe("down");
    expect(mermaidGfxDirectionFromArrowKey("ArrowUp")).toBe("up");
    expect(mermaidGfxDirectionFromArrowKey("Enter")).toBe("");
  });

  test("finds nearest node in arrow direction with cross-distance penalty", () => {
    const bounds = new Map([
      ["A", new Bound(0, 0, 100, 60).serialize()],
      ["right-close", new Bound(160, 20, 100, 60).serialize()],
      ["right-far-straight", new Bound(220, 0, 100, 60).serialize()],
      ["down", new Bound(20, 160, 100, 60).serialize()],
      ["left", new Bound(-180, 0, 100, 60).serialize()],
      ["excluded", new Bound(120, 0, 100, 60).serialize()],
    ]);
    const nodes = [...bounds.keys()].map((id) => ({ id }));
    const getNodeXywh = (nodeId: string) => bounds.get(nodeId);

    expect(mermaidGfxNodeCenter(bounds.get("A")!)).toEqual({ x: 50, y: 30 });
    expect(
      findNearestMermaidGfxNodeInDirection({
        direction: "right",
        fromNodeId: "A",
        getNodeXywh,
        nodes,
      }),
    ).toBe("excluded");
    expect(
      findNearestMermaidGfxNodeInDirection({
        direction: "right",
        excludedNodeIds: new Set(["excluded"]),
        fromNodeId: "A",
        getNodeXywh,
        nodes,
      }),
    ).toBe("right-close");
    expect(
      findNearestMermaidGfxNodeInDirection({
        direction: "down",
        fromNodeId: "A",
        getNodeXywh,
        nodes,
      }),
    ).toBe("down");
    expect(
      findNearestMermaidGfxNodeInDirection({
        direction: "up",
        fromNodeId: "A",
        getNodeXywh,
        nodes,
      }),
    ).toBe("");
  });
});
