// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DomRenderer } from "@virgultum/editor/blocks/surface";
import { beforeEach, describe, expect, test } from "vitest";

import { flushFrame } from "../../harness/pointer.js";
import { getMountedSurface, mountTestSession } from "../../harness/session.js";

function expectPxCloseTo(raw: string, expected: number, digits = 2): void {
  expect(Number.parseFloat(raw)).toBeCloseTo(expected, digits);
}

describe("DomRenderer shape and connector projection", () => {
  beforeEach(async () => {
    return mountTestSession("edgeless", [], { enableDomRenderer: true });
  });

  test("activates DomRenderer and projects shape geometry, radius, and deletion", async () => {
    const surfaceView = getMountedSurface(window.doc, window.editor);
    const surfaceModel = surfaceView.model;
    expect(surfaceView.renderer).toBeInstanceOf(DomRenderer);

    const zoom = surfaceView.renderer.viewport.zoom;

    const roundedId = surfaceModel.addElement({
      type: "shape",
      subType: "rectangle",
      xywh: "[150, 150, 80, 60]",
      radius: 0.1,
      fill: "#ff0000",
      stroke: "#000000",
    });
    const diamondId = surfaceModel.addElement({
      type: "shape",
      subType: "diamond",
      xywh: "[150, 150, 80, 60]",
      fillColor: "#ff0000",
      strokeColor: "#000000",
      filled: true,
    });
    const triangleId = surfaceModel.addElement({
      type: "shape",
      subType: "triangle",
      xywh: "[150, 150, 80, 60]",
      fillColor: "#ff0000",
      strokeColor: "#000000",
      filled: true,
    });

    await flushFrame(100);

    const roundedEl = surfaceView.querySelector<HTMLElement>(
      `[data-element-id="${roundedId}"]`,
    );
    expect(roundedEl).toBeInstanceOf(HTMLElement);
    expectPxCloseTo(roundedEl!.style.borderRadius, 6 * zoom);

    for (const id of [diamondId, triangleId]) {
      const el = surfaceView.querySelector<HTMLElement>(
        `[data-element-id="${id}"]`,
      );
      expect(el).toBeInstanceOf(HTMLElement);
      expectPxCloseTo(el!.style.width, 80 * zoom);
      expectPxCloseTo(el!.style.height, 60 * zoom);
    }

    surfaceModel.deleteElement(roundedId);
    await flushFrame(100);
    expect(
      surfaceView.querySelector(`[data-element-id="${roundedId}"]`),
    ).toBeNull();
  });

  test("projects connectors with SVG paths, dasharray, endpoint markers, and removal", async () => {
    const surfaceView = getMountedSurface(window.doc, window.editor);
    const surfaceModel = surfaceView.model;

    const s1 = surfaceModel.addElement({
      type: "shape",
      xywh: "[100, 100, 80, 60]",
    });
    const s2 = surfaceModel.addElement({
      type: "shape",
      xywh: "[300, 200, 80, 60]",
    });

    const linkedId = surfaceModel.addElement({
      type: "connector",
      source: { id: s1 },
      target: { id: s2 },
      stroke: "#000000",
      strokeWidth: 2,
    });

    const dashedId = surfaceModel.addElement({
      type: "connector",
      source: { position: [100, 100] },
      target: { position: [200, 200] },
      strokeStyle: "dash",
      stroke: "#ff0000",
      strokeWidth: 4,
      frontEndpointStyle: "Triangle",
      rearEndpointStyle: "Arrow",
    });

    await flushFrame(400);

    const linkedEl = surfaceView.querySelector(
      `[data-element-id="${linkedId}"]`,
    );
    expect(linkedEl).toBeInstanceOf(HTMLElement);
    expect(linkedEl?.querySelector("svg")).not.toBeNull();

    const dashedEl = surfaceView.querySelector(
      `[data-element-id="${dashedId}"]`,
    );
    const dashedSvg = dashedEl?.querySelector("svg");
    expect(dashedSvg).not.toBeNull();

    const paths = dashedSvg!.querySelectorAll("path");
    const mainPath = paths[paths.length - 1];
    expect(mainPath.getAttribute("stroke-dasharray")).toBe("12,12");

    const markers = dashedSvg!.querySelectorAll("defs marker");
    expect(markers.length).toBeGreaterThan(0);

    surfaceModel.deleteElement(linkedId);
    await flushFrame(100);
    expect(
      surfaceView.querySelector(`[data-element-id="${linkedId}"]`),
    ).toBeNull();
  });
});
