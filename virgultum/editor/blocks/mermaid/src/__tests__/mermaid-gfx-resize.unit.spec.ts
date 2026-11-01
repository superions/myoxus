import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  createMermaidGfxResizeStart,
  mermaidGfxResizeCoalesceKey,
  resizeMermaidGfxBoundByDirection,
  resizeMermaidGfxBoundFromDrag,
  resizeMermaidViewportHeightByDirection,
  resolveMermaidGfxResizeTarget,
} from "../mermaid-gfx-resize.js";

describe("Mermaid GFX resize helpers", () => {
  test("resizes node and subgraph bounds by keyboard direction", () => {
    const xywh = new Bound(10, 20, 120, 80).serialize();

    expect(
      resizeMermaidGfxBoundByDirection({
        direction: "right",
        step: 16,
        xywh,
      }),
    ).toEqual({ height: 80, width: 136 });
    expect(
      resizeMermaidGfxBoundByDirection({
        direction: "left",
        step: 16,
        xywh,
      }),
    ).toEqual({ height: 80, width: 104 });
    expect(
      resizeMermaidGfxBoundByDirection({
        direction: "down",
        step: 48,
        xywh,
      }),
    ).toEqual({ height: 128, width: 120 });
    expect(
      resizeMermaidGfxBoundByDirection({
        direction: "up",
        step: 48,
        xywh,
      }),
    ).toEqual({ height: 32, width: 120 });
  });

  test("resizes flowchart viewport height only on vertical directions", () => {
    expect(
      resizeMermaidViewportHeightByDirection({
        currentHeight: 420,
        direction: "down",
        step: 24,
      }),
    ).toBe(444);
    expect(
      resizeMermaidViewportHeightByDirection({
        currentHeight: 420,
        direction: "up",
        step: 24,
      }),
    ).toBe(396);
    expect(
      resizeMermaidViewportHeightByDirection({
        currentHeight: 420,
        direction: "left",
        step: 24,
      }),
    ).toBeNull();
  });

  test("creates pointer resize starts and derives dimensions from drag deltas", () => {
    const start = createMermaidGfxResizeStart({
      pointer: { x: 260, y: 140 },
      xywh: new Bound(10, 20, 120, 80).serialize(),
    });

    expect(start).toEqual({
      height: 80,
      width: 120,
      x: 260,
      y: 140,
    });
    expect(
      resizeMermaidGfxBoundFromDrag({
        pointer: { x: 308, y: 172 },
        start,
      }),
    ).toEqual({
      height: 112,
      width: 168,
    });
    expect(
      resizeMermaidGfxBoundFromDrag({
        pointer: { x: 240, y: 110 },
        start,
      }),
    ).toEqual({
      height: 50,
      width: 100,
    });
  });

  test("resolves editable resize targets with concrete persisted bounds", () => {
    const nodeXywh = new Bound(10, 20, 120, 80).serialize();
    const subgraphXywh = new Bound(40, 50, 240, 160).serialize();

    expect(
      resolveMermaidGfxResizeTarget({
        isReadonly: false,
        kind: "node",
        nodeId: "A",
        nodeModel: { xywh: nodeXywh },
        subgraphId: "cluster",
        subgraphModel: { xywh: subgraphXywh },
      }),
    ).toEqual({
      id: "A",
      kind: "node",
      xywh: nodeXywh,
    });
    expect(
      resolveMermaidGfxResizeTarget({
        isReadonly: false,
        kind: "subgraph",
        nodeId: "A",
        nodeModel: { xywh: nodeXywh },
        subgraphId: "cluster",
        subgraphModel: { xywh: subgraphXywh },
      }),
    ).toEqual({
      id: "cluster",
      kind: "subgraph",
      xywh: subgraphXywh,
    });
  });

  test("rejects resize targets that cannot be safely mutated", () => {
    const xywh = new Bound(10, 20, 120, 80).serialize();

    expect(
      resolveMermaidGfxResizeTarget({
        isReadonly: true,
        kind: "node",
        nodeId: "A",
        nodeModel: { xywh },
        subgraphId: "",
        subgraphModel: null,
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxResizeTarget({
        isReadonly: false,
        kind: "node",
        nodeId: "",
        nodeModel: { xywh },
        subgraphId: "",
        subgraphModel: null,
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxResizeTarget({
        isReadonly: false,
        kind: "subgraph",
        nodeId: "",
        nodeModel: null,
        subgraphId: "cluster",
        subgraphModel: {},
      }),
    ).toBeNull();
  });

  test("derives stable coalescing keys for resize drag mutations", () => {
    expect(mermaidGfxResizeCoalesceKey({ id: "A", kind: "node" })).toBe(
      "flowchart-node-resize:A",
    );
    expect(
      mermaidGfxResizeCoalesceKey({
        id: "cluster",
        kind: "subgraph",
      }),
    ).toBe("flowchart-subgraph-resize:cluster");
  });
});
