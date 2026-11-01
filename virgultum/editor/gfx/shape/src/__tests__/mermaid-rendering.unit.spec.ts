import type { DomRenderer } from "@virgultum/block-surface";
import {
  MERMAID_SHAPE_TYPES,
  mermaidPersonGeometry,
  type ShapeElementModel,
  shapeMethods,
  ShapeType,
} from "@virgultum/model";
import { describe, expect, it } from "vitest";
import { Bound } from "@virgultum/global/gfx";
import { normalizeShapeBound } from "../element-renderer/shape/utils.js";

import { shapeDomRenderer } from "../element-renderer/shape-dom/index.js";
import { createMermaidSvgElement } from "../element-renderer/shape-dom/mermaid-svg.js";

function shapeModel(
  shapeType: ShapeType,
  overrides: Partial<ShapeElementModel> = {},
): ShapeElementModel {
  return {
    shapeType: shapeType as ShapeType,
    shapeStyle: "General",
    w: 140,
    h: 90,
    rotate: 0,
    radius: 0,
    mermaidContour: [],
    filled: true,
    fillColor: "#ffffff",
    strokeColor: "#1f2937",
    strokeStyle: "solid",
    strokeWidth: 2,
    textDisplay: false,
    text: "",
    color: "#1f2937",
    shadow: null,
    fontFamily: "Arial",
    fontSize: 14,
    fontWeight: "400",
    textAlign: "center",
    textVerticalAlign: "center",
    padding: [0, 0],
    ...overrides,
  } as unknown as ShapeElementModel;
}

describe("Mermaid flowchart shape registration", () => {
  it("keeps a resized rail thin when its attached text is hidden", () => {
    const rail = shapeModel(ShapeType.Rect, {
      text: { toString: () => "", toDelta: () => [] } as never,
    });
    expect(
      normalizeShapeBound(rail, new Bound(10, 20, 300, 1.3)).serialize(),
    ).toBe(new Bound(10, 20, 300, 1.3).serialize());
  });
  it("registers every Mermaid shape type for GFX geometry", () => {
    expect(MERMAID_SHAPE_TYPES.length).toBeGreaterThanOrEqual(40);
    for (const type of MERMAID_SHAPE_TYPES) {
      expect(type).toMatch(/^mermaid-/);
      expect(shapeMethods[type]).toBeDefined();
      expect(shapeMethods[type].getNearestPoint).toBeTypeOf("function");
      expect(shapeMethods[type].getLineIntersections).toBeTypeOf("function");
    }
  });

  it("renders every Mermaid shape type as non-empty DOM SVG", () => {
    for (const type of MERMAID_SHAPE_TYPES) {
      const svg = createMermaidSvgElement(
        shapeModel(type),
        "#ffffff",
        "#1f2937",
      );

      expect(svg?.tagName.toLowerCase()).toBe("svg");
      expect(svg?.children.length).toBeGreaterThan(0);
    }
  });

  it("keeps semantic Mermaid-only shapes visually distinct from generic rectangles", () => {
    const asymmetric = createMermaidSvgElement(
      shapeModel(ShapeType.MermaidAsymmetric),
      "#ffffff",
      "#1f2937",
    );
    expect(asymmetric?.querySelector("polygon")?.getAttribute("points")).toBe(
      "0,0 120.39999999999999,0 140,45 120.39999999999999,90 0,90 16.8,45",
    );

    const datastore = createMermaidSvgElement(
      shapeModel(ShapeType.MermaidDatastore),
      "#ffffff",
      "#1f2937",
    );
    expect(datastore?.querySelector("path")?.getAttribute("d")).toContain(
      "M 0 14.4 L 140 14.4",
    );
    expect(datastore?.querySelector("path")?.getAttribute("fill")).toBe(
      "transparent",
    );

    const horizontalCylinder = createMermaidSvgElement(
      shapeModel(ShapeType.MermaidHCyl),
      "#ffffff",
      "#1f2937",
    );
    expect(
      horizontalCylinder?.querySelector("path")?.getAttribute("d"),
    ).toContain("A 22.400000000000002 45");
    expect(horizontalCylinder?.querySelector("ellipse")).not.toBeNull();

    const delay = createMermaidSvgElement(
      shapeModel(ShapeType.MermaidDelay),
      "#ffffff",
      "#1f2937",
    );
    expect(delay?.querySelector("path")?.getAttribute("d")).toContain(
      "Q 140 0",
    );

    const subroutine = createMermaidSvgElement(
      shapeModel(ShapeType.MermaidSubroutine),
      "#ffffff",
      "#1f2937",
    );
    expect(subroutine?.querySelectorAll("line")).toHaveLength(2);

    const text = createMermaidSvgElement(
      shapeModel(ShapeType.MermaidText),
      "#ffffff",
      "#1f2937",
    );
    expect(text?.querySelector("polygon")?.getAttribute("stroke")).toBe(
      "transparent",
    );
  });

  it("uses the supplied Block contour for DOM paint and native intersections", () => {
    const model = shapeModel(ShapeType.MermaidBlockArrow, {
      mermaidContour: [
        [0, 0],
        [1, 1],
        [0, 1],
      ],
      x: 0,
      y: 0,
      xywh: "[0,0,140,90]",
    });
    const svg = createMermaidSvgElement(model, "#ffffff", "#1f2937");
    expect(svg?.querySelector("polygon")?.getAttribute("points")).toBe(
      "0,0 140,90 0,90",
    );
    const points = shapeMethods[
      ShapeType.MermaidBlockArrow
    ].getLineIntersections([100, 0], [100, 90], model);
    expect(points?.[0]?.[0]).toBeCloseTo(100);
    expect(points?.[0]?.[1]).toBeCloseTo((90 * 100) / 140);
  });

  it("paints the shared Person body and head while protecting head space and contour ports", () => {
    const model = shapeModel(ShapeType.MermaidPerson, {
      x: 0,
      y: 0,
      xywh: "[0,0,140,90]",
    });
    const geometry = mermaidPersonGeometry(model.w, model.h);
    const svg = createMermaidSvgElement(model, "#ffffff", "#1f2937")!;
    expect(svg.children[0].tagName).toBe("rect");
    expect(svg.children[1].tagName).toBe("circle");
    expect(Number(svg.querySelector("circle")!.getAttribute("r"))).toBe(
      geometry.head.radius,
    );
    expect(Number(svg.querySelector("rect")!.getAttribute("y"))).toBe(
      geometry.body.y,
    );
    expect(geometry.textRegion.y).toBeGreaterThanOrEqual(
      geometry.head.radius * 2,
    );
    const methods = shapeMethods[ShapeType.MermaidPerson];
    const intersections = methods.getLineIntersections(
      [0, geometry.head.cy],
      [140, geometry.head.cy],
      model,
    )!;
    expect(intersections).toHaveLength(2);
    expect(intersections.every((p) => p[0] > 0 && p[0] < model.w)).toBe(true);
    const port = methods.getRelativePointLocation([0, 0], model);
    const nearest = methods.getNearestPoint([0, 0], model);
    expect(port[0]).toBeCloseTo(nearest[0]);
    expect(port[1]).toBeCloseTo(nearest[1]);
  });

  it("routes Mermaid shapes through the shared DOM shape renderer", () => {
    const element = document.createElement("div");
    const renderer = {
      viewport: { zoom: 1 },
      getColorValue: (color: string | null | undefined, fallback?: string) =>
        color ?? fallback ?? "transparent",
    } as unknown as DomRenderer;

    shapeDomRenderer(shapeModel(MERMAID_SHAPE_TYPES[0]), element, renderer);

    expect(element.style.borderStyle).toBe("none");
    expect(element.querySelector("svg")).not.toBeNull();
  });
});
