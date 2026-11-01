import { describe, expect, test } from "vitest";

import {
  accumulateMermaidGfxNodeDrag,
  releaseMermaidGfxPreviewProperty,
  resolveMermaidGfxNodeDragDelta,
  resolveMermaidGfxNodeDragEndSubgraph,
} from "../mermaid-gfx-drag.js";

describe("Mermaid GFX node drag helpers", () => {
  test("releases a Page preview without overwriting committed owner geometry", () => {
    let committedXywh = "[20,30,160,80]";
    const element = {
      xywh: "[220,130,160,80]",
      yMap: {
        get: () => committedXywh,
      },
      pop: () => {
        committedXywh = element.xywh;
      },
    };

    releaseMermaidGfxPreviewProperty(element, "xywh");

    expect(element.xywh).toBe("[20,30,160,80]");
    expect(committedXywh).toBe("[20,30,160,80]");
  });

  test("accumulates pointer deltas independently of a shifting owner origin", () => {
    const model = {
      diagramType: "flowchart" as const,
      direction: "TD" as const,
      edges: [],
      nodes: [
        {
          height: 80,
          id: "A",
          label: "Start",
          shape: "rect" as const,
          width: 160,
          x: 40,
          y: 20,
        },
      ],
      styleStatements: [],
      version: 1 as const,
    };

    const beyondLeft = accumulateMermaidGfxNodeDrag(model, "A", -75, 0);
    const fartherLeft = accumulateMermaidGfxNodeDrag(beyondLeft, "A", -25, 10);

    expect(fartherLeft.nodes[0]).toMatchObject({ x: -60, y: 30 });
    expect(model.nodes[0]).toMatchObject({ x: 40, y: 20 });
  });

  test("keeps sub-threshold movement from creating GFX mutations while advancing drag origin", () => {
    const smallMove = resolveMermaidGfxNodeDragDelta({
      lastPoint: { x: 10, y: 20 },
      nextPoint: { x: 10.2, y: 20.4 },
    });
    expect(smallMove?.dx).toBeCloseTo(0.2);
    expect(smallMove?.dy).toBeCloseTo(0.4);
    expect(smallMove?.nextPoint).toEqual({ x: 10.2, y: 20.4 });
    expect(smallMove?.shouldMove).toBe(false);

    expect(
      resolveMermaidGfxNodeDragDelta({
        lastPoint: { x: 10, y: 20 },
        nextPoint: { x: 11, y: 19.25 },
      }),
    ).toEqual({
      dx: 1,
      dy: -0.75,
      nextPoint: { x: 11, y: 19.25 },
      shouldMove: true,
    });
    expect(
      resolveMermaidGfxNodeDragDelta({
        lastPoint: null,
        nextPoint: { x: 10, y: 20 },
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxNodeDragDelta({
        lastPoint: { x: 10, y: 20 },
        nextPoint: null,
      }),
    ).toBeNull();
  });

  test("resolves the containing subgraph after drag end by node membership", () => {
    expect(
      resolveMermaidGfxNodeDragEndSubgraph({
        draggedNodeId: "B",
        subgraphs: [
          { id: "cluster-a", nodeIds: ["A"] },
          { id: "cluster-b", nodeIds: ["B", "C"] },
        ],
      }),
    ).toBe("cluster-b");
    expect(
      resolveMermaidGfxNodeDragEndSubgraph({
        draggedNodeId: "D",
        subgraphs: [{ id: "cluster-b", nodeIds: ["B", "C"] }],
      }),
    ).toBe("");
    expect(
      resolveMermaidGfxNodeDragEndSubgraph({
        draggedNodeId: "",
        subgraphs: [{ id: "cluster-b", nodeIds: ["B", "C"] }],
      }),
    ).toBe("");
  });
});
