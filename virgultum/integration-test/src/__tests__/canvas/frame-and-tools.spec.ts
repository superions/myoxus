// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { FrameBlockComponent } from "@virgultum/editor/blocks/frame";
import type { EdgelessRootBlockComponent } from "@virgultum/editor/blocks/root";
import {
  DefaultTool,
  type SurfaceBlockComponent,
} from "@virgultum/editor/blocks/surface";
import { assertType } from "@virgultum/editor/global/utils";
import type { FrameBlockModel } from "@virgultum/editor/model";
import { Text } from "@virgultum/editor/store";
import { beforeEach, describe, expect, test } from "vitest";

import {
  dispatchClick,
  dispatchDrag,
  flushFrame,
} from "../../harness/pointer.js";
import {
  getEdgelessRoot,
  getMountedSurface,
  insertTestNote,
  mountTestSession,
} from "../../harness/session.js";

describe("frame geometry and DefaultTool pointer actions", () => {
  let edgeless!: EdgelessRootBlockComponent;
  let surface!: SurfaceBlockComponent;
  let service!: EdgelessRootBlockComponent["service"];

  beforeEach(async () => {
    const dispose = await mountTestSession("edgeless");
    edgeless = getEdgelessRoot(window.doc, window.editor, "edgeless");
    surface = getMountedSurface(window.doc, window.editor);
    service = edgeless.service;
    edgeless.gfx.tool.setTool(DefaultTool);
    return dispose;
  });

  test("positions top-level and nested <myoxus-frame-title> elements in model space", async () => {
    const outerId = service.doc.addBlock(
      "myoxus:frame",
      { xywh: "[0,0,300,300]", title: new Text("Outer") },
      service.surface.id,
    );
    await flushFrame();

    const findTitle = (id: string) =>
      service.std.view.getBlock(id)?.querySelector("myoxus-frame-title");

    const outerTitle = findTitle(outerId);
    expect(outerTitle).toBeTruthy();
    const outerRect = outerTitle!.getBoundingClientRect();
    expect(outerRect.width).toBeGreaterThan(0);
    expect(outerRect.height).toBeGreaterThan(0);

    const [outerX, outerY] = service.viewport.toModelCoordFromClientCoord([
      outerRect.x,
      outerRect.y,
    ]);
    expect(outerX).toBeCloseTo(0);
    expect(outerY).toBeLessThan(0);

    const innerId = service.doc.addBlock(
      "myoxus:frame",
      { xywh: "[20,20,200,200]", title: new Text("Inner") },
      service.surface.id,
    );
    await flushFrame();

    const innerRect = findTitle(innerId)!.getBoundingClientRect();
    const [innerX, innerY] = service.viewport.toModelCoordFromClientCoord([
      innerRect.x,
      innerRect.y,
    ]);
    expect(innerX).toBeGreaterThan(20);
    expect(innerY).toBeGreaterThan(20);
  });

  test("populates externalXYWH once viewport pans to contain frame", async () => {
    const frameId = service.doc.addBlock(
      "myoxus:frame",
      { xywh: "[1800,1800,200,200]", title: new Text("Far Frame") },
      service.surface.id,
    );
    await flushFrame();

    const block = service.doc.getBlock(frameId);
    expect(block).toBeTruthy();
    assertType<FrameBlockComponent>(block);

    service.viewport.setCenter(900, 900);
    expect(block?.model.externalXYWH).toBeDefined();
  });

  test("prevents cyclic frame ancestry via addChild", async () => {
    const frames = [1, 2, 3].map((n) => {
      const id = service.doc.addBlock(
        "myoxus:frame",
        { xywh: "[0,0,300,300]", title: new Text(`Frame ${n}`) },
        service.surface.id,
      );
      return service.doc.getBlock(id)?.model as FrameBlockModel;
    });
    await flushFrame();

    frames[0].addChild(frames[1]);
    frames[1].addChild(frames[2]);
    frames[2].addChild(frames[0]);
    await flushFrame();

    expect(frames[0].descendantElements).toHaveLength(2);
    expect(frames[1].descendantElements).toHaveLength(1);
    expect(frames[2].descendantElements).toHaveLength(0);
  });

  test("selects and drags canvas shapes with DefaultTool", async () => {
    const shapeId = service.crud.addElement("shape", {
      shapeType: "rect",
      xywh: "[0,0,100,100]",
      fillColor: "red",
    })!;
    await flushFrame();

    service.viewport.setViewport(1, [
      service.viewport.width / 2,
      service.viewport.height / 2,
    ]);
    await flushFrame();

    dispatchClick(edgeless.host, { x: 0, y: 50 });
    expect(service.selection.surfaceSelections[0].elements).toEqual([shapeId]);

    dispatchDrag(edgeless.host, { x: 0, y: 50 }, { x: 0, y: 150 });
    await flushFrame();
    expect(service.crud.getElementById(shapeId)!.xywh).toBe("[0,100,100,100]");
  });

  test("selects and drags a note block with DefaultTool", async () => {
    const noteId = insertTestNote(doc);
    await flushFrame();

    service.viewport.setViewport(1, [
      surface.renderer.viewport.width / 2,
      surface.renderer.viewport.height / 2,
    ]);
    await flushFrame();

    dispatchClick(edgeless.host, { x: 50, y: 50 });
    expect(service.selection.surfaceSelections[0].elements).toEqual([noteId]);

    dispatchDrag(edgeless.host, { x: 50, y: 50 }, { x: 150, y: 150 });
    await flushFrame();

    const [x, y] = JSON.parse(service.crud.getElementById(noteId)!.xywh);
    expect([x, y]).toEqual([100, 100]);
  });
});
