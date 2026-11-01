import { describe, expect, test } from "vitest";

import {
  clampMermaidVisualViewportHeight,
  createMermaidScopedGfxFitKey,
  resolveMermaidPageViewportCenterPosition,
  resolveMermaidScopedModelFallbackPoint,
  resolveMermaidScopedModelPointFromClient,
  resolveMermaidScopedPageViewportFit,
  resolveMermaidScopedViewPoint,
  resolveMermaidScopedViewportFallbackPoint,
  resolveMermaidScopedViewportZoom,
  resolveMermaidVisualViewportHeight,
} from "../mermaid-gfx-viewport.js";

describe("Mermaid scoped GFX viewport state", () => {
  test("centres the real diagram content instead of asymmetric owner whitespace", () => {
    const position = resolveMermaidPageViewportCenterPosition({
      contentBound: { h: 540, w: 700, x: 300, y: 180 },
      navigationBound: { h: 900, w: 1080, x: 0, y: 0 },
      padding: [36, 36, 36, 36],
      scale: 1,
      viewportRect: { height: 544, width: 823 },
    });

    expect(position).toEqual({ scrollLeft: 274.5, scrollTop: 214 });
    expect(-36 + position!.scrollLeft + 823 / 2).toBe(650);
    expect(-36 + position!.scrollTop + 544 / 2).toBe(450);
  });

  test("clamps persisted page-mode viewport height to the supported range", () => {
    expect(
      clampMermaidVisualViewportHeight(120, {
        max: 900,
        min: 240,
      }),
    ).toBe(240);
    expect(
      clampMermaidVisualViewportHeight(1200, {
        max: 900,
        min: 240,
      }),
    ).toBe(900);
    expect(
      clampMermaidVisualViewportHeight(405.6, {
        max: 900,
        min: 240,
      }),
    ).toBe(406);
  });

  test("uses finite stored height and falls back to auto height otherwise", () => {
    expect(
      resolveMermaidVisualViewportHeight({
        autoHeight: 360,
        storedHeight: 480.4,
      }),
    ).toBe(480);
    expect(
      resolveMermaidVisualViewportHeight({
        autoHeight: 360,
        storedHeight: Number.POSITIVE_INFINITY,
      }),
    ).toBe(360);
    expect(
      resolveMermaidVisualViewportHeight({
        autoHeight: 360,
        storedHeight: null,
      }),
    ).toBe(360);
  });

  test("creates a stable fit key from frame geometry and ordered GFX children", () => {
    expect(
      createMermaidScopedGfxFitKey({
        elementIds: ["node-A", "edge-A-B", "node-B"],
        ownerXywh: "[0,0,640,480]",
      }),
    ).toBe("[0,0,640,480]:node-A,edge-A-B,node-B");
    expect(
      createMermaidScopedGfxFitKey({
        elementIds: ["node-B", "node-A"],
        ownerXywh: "[0,0,640,480]",
      }),
    ).not.toBe(
      createMermaidScopedGfxFitKey({
        elementIds: ["node-A", "node-B"],
        ownerXywh: "[0,0,640,480]",
      }),
    );
  });

  test("centres an explicit zoom state on the diagram owner", () => {
    expect(
      resolveMermaidScopedViewportZoom({
        ownerBound: { h: 300, w: 400, x: 100, y: 50 },
        zoom: 1,
      }),
    ).toEqual({ center: [300, 200], zoom: 1 });
    expect(
      resolveMermaidScopedViewportZoom({
        ownerBound: { h: 300, w: 400, x: 100, y: 50 },
        zoom: 0,
      }),
    ).toBeNull();
  });

  test("maps scoped page fallback coordinates between model and viewport space", () => {
    const ownerBound = { h: 300, w: 400, x: 100, y: 50 };
    const padding = [50, 50, 50, 50] as const;
    const viewportRect = {
      height: 400,
      left: 10,
      top: 20,
      width: 500,
    } as DOMRect;

    expect(
      resolveMermaidScopedPageViewportFit({
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportRect,
      }),
    ).toEqual({
      viewportX: 50,
      viewportY: 0,
      zoom: 1,
    });
    expect(
      resolveMermaidScopedModelFallbackPoint({
        clientX: 260,
        clientY: 220,
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportRect,
      }),
    ).toEqual({ x: 300, y: 200 });
    expect(
      resolveMermaidScopedViewportFallbackPoint({
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportRect,
        x: 300,
        y: 200,
      }),
    ).toEqual({ left: 250, top: 200 });
  });

  test("keeps dense diagrams at their type-owned readable zoom and exposes overflow", () => {
    const padding = [50, 50, 50, 50] as const;

    expect(
      resolveMermaidScopedPageViewportFit({
        ownerBound: { h: 300, w: 800, x: 0, y: 0 },
        minReadableZoom: 0.85,
        padding,
        viewportRect: { height: 400, width: 500 },
      })?.zoom,
    ).toBe(0.85);
    expect(
      resolveMermaidScopedPageViewportFit({
        ownerBound: { h: 800, w: 400, x: 0, y: 0 },
        minReadableZoom: 0.85,
        padding,
        viewportRect: { height: 400, width: 500 },
      })?.zoom,
    ).toBe(0.85);
  });

  test("uses native GFX viewport transforms and falls back when they are invalid", () => {
    const ownerBound = { h: 300, w: 400, x: 100, y: 50 };
    const padding = [50, 50, 50, 50] as const;
    const viewportRect = {
      height: 400,
      left: 10,
      top: 20,
      width: 500,
    } as DOMRect;

    expect(
      resolveMermaidScopedModelPointFromClient({
        clientX: 260,
        clientY: 220,
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportController: {
          toModelCoord: (left, top) => [left + 1000, top + 2000],
        },
        viewportRect,
      }),
    ).toEqual({ x: 1250, y: 2200 });
    expect(
      resolveMermaidScopedModelPointFromClient({
        clientX: 260,
        clientY: 220,
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportController: {
          toModelCoord: () => [Number.NaN, Number.NaN],
        },
        viewportRect,
      }),
    ).toEqual({ x: 300, y: 200 });
    expect(
      resolveMermaidScopedViewPoint({
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportController: {
          toViewCoord: (x, y) => [x + 7, y + 11],
        },
        viewportRect,
        x: 300,
        y: 200,
      }),
    ).toEqual({ left: 307, top: 211 });
    expect(
      resolveMermaidScopedViewPoint({
        ownerBound,
        minReadableZoom: 0.5,
        padding,
        viewportController: {
          toViewCoord: () => [Number.POSITIVE_INFINITY, 0],
        },
        viewportRect,
        x: 300,
        y: 200,
      }),
    ).toEqual({ left: 250, top: 200 });
  });
});
