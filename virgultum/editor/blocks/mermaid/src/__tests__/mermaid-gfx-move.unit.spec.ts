import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  createMermaidGfxMoveStart,
  mermaidGfxMoveCoalesceKey,
  moveMermaidGfxBoundByDirection,
  moveMermaidGfxBoundFromDrag,
} from "../mermaid-gfx-move.js";

describe("Mermaid GFX move geometry", () => {
  test("moves bounds by pointer delta from the initial model point", () => {
    const start = createMermaidGfxMoveStart({
      pointer: { x: 40, y: 50 },
      xywh: new Bound(10, 20, 120, 80).serialize(),
    });

    expect(start).toEqual({ pointerX: 40, pointerY: 50, x: 10, y: 20 });
    expect(
      moveMermaidGfxBoundFromDrag({
        pointer: { x: 72, y: 83 },
        start,
      }),
    ).toEqual({ x: 42, y: 53 });
  });

  test("moves bounds by keyboard direction and uses stable coalescing keys", () => {
    const xywh = new Bound(10, 20, 120, 80).serialize();

    expect(
      moveMermaidGfxBoundByDirection({
        direction: "left",
        step: 16,
        xywh,
      }),
    ).toEqual({ x: -6, y: 20 });
    expect(
      moveMermaidGfxBoundByDirection({
        direction: "down",
        step: 48,
        xywh,
      }),
    ).toEqual({ x: 10, y: 68 });
    expect(
      mermaidGfxMoveCoalesceKey({ id: "cluster-review", kind: "subgraph" }),
    ).toBe("flowchart-subgraph-move:cluster-review");
  });
});
