// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import {
  MERMAID_GFX_GRID_SIZE,
  resolveMermaidGfxMoveSnap,
  resolveMermaidGfxResizeSnap,
  snapValueToMermaidGrid,
} from "../mermaid-gfx-snap.js";

describe("Mermaid GFX grid & smart alignment snap", () => {
  test("snaps coordinates to the 20px visual grid step", () => {
    expect(MERMAID_GFX_GRID_SIZE).toBe(20);
    expect(snapValueToMermaidGrid(27)).toBe(20);
    expect(snapValueToMermaidGrid(31)).toBe(40);
    expect(snapValueToMermaidGrid(-11)).toBe(-20);
  });

  test("prioritizes sibling edge and center alignment over grid snapping and emits guides", () => {
    const result = resolveMermaidGfxMoveSnap({
      movingRect: { x: 103, y: 152, width: 100, height: 48 },
      candidates: [
        { id: "A", x: 100, y: 20, width: 100, height: 48 },
        { id: "B", x: 300, y: 150, width: 80, height: 48 },
      ],
      gridEnabled: true,
      zoom: 1,
    });
    expect(result.dx).toBe(-3);
    expect(result.dy).toBe(-2);
    expect(
      result.guides.some(
        (guide) => guide.axis === "x" && guide.position === 100,
      ),
    ).toBe(true);
    expect(
      result.guides.some(
        (guide) => guide.axis === "y" && guide.position === 150,
      ),
    ).toBe(true);
  });

  test("falls back to grid snapping when no sibling aligns and bypasses both when Alt is held", () => {
    const gridSnap = resolveMermaidGfxMoveSnap({
      movingRect: { x: 113, y: 127, width: 100, height: 48 },
      candidates: [{ id: "A", x: 0, y: 0, width: 80, height: 40 }],
      gridEnabled: true,
      zoom: 1,
    });
    expect(gridSnap.dx).toBe(7); // 113 -> 120
    expect(gridSnap.dy).toBe(-7); // 127 -> 120
    expect(gridSnap.guides).toEqual([]);

    const bypassed = resolveMermaidGfxMoveSnap({
      movingRect: { x: 113, y: 127, width: 100, height: 48 },
      candidates: [{ id: "A", x: 114, y: 128, width: 80, height: 40 }],
      gridEnabled: true,
      zoom: 1,
      bypass: true,
    });
    expect(bypassed).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  test("detects equal spacing between siblings and emits spacing guides", () => {
    const result = resolveMermaidGfxMoveSnap({
      movingRect: { x: 243, y: 20, width: 80, height: 40 },
      candidates: [
        { id: "A", x: 0, y: 20, width: 80, height: 40 },
        { id: "B", x: 120, y: 20, width: 80, height: 40 },
      ],
      gridEnabled: false,
      zoom: 1,
    });
    // Gap between A (end 80) and B (start 120) is 40; target start after B is 200 + 40 = 240
    expect(result.dx).toBe(-3);
    expect(result.guides.filter((g) => g.kind === "spacing")).toHaveLength(2);
    expect(result.guides.find((g) => g.kind === "spacing")?.spacingGap).toBe(
      40,
    );
  });

  test("snaps resize dimensions to sibling edges or grid while preserving minimums", () => {
    const edgeSnap = resolveMermaidGfxResizeSnap({
      rect: { x: 40, y: 40, width: 158, height: 63 },
      candidates: [{ id: "A", x: 200, y: 0, width: 80, height: 100 }],
      minWidth: 80,
      minHeight: 40,
      gridEnabled: true,
      zoom: 1,
    });
    expect(edgeSnap.width).toBe(160); // right aligns to 200
    expect(edgeSnap.height).toBe(60); // snaps to 20px grid
    expect(
      edgeSnap.guides.some((g) => g.axis === "x" && g.position === 200),
    ).toBe(true);
  });
});
