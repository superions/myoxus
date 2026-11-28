// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { FrameBlockComponent } from "@virgultum/editor/blocks/frame";
import {
  type EdgelessRootBlockComponent,
  EdgelessRootService,
} from "@virgultum/editor/blocks/root";
import type { SurfaceRefBlockComponent } from "@virgultum/editor/blocks/surface-ref";
import { beforeEach, describe, expect, test } from "vitest";

import { flushFrame } from "../../harness/pointer.js";
import {
  getEdgelessRoot,
  insertTestNote,
  mountTestSession,
} from "../../harness/session.js";

describe("SurfaceRefBlockComponent preview, navigation, and placeholder", () => {
  let service!: EdgelessRootBlockComponent["service"];
  let noteAId = "";
  let noteBId = "";
  let shapeAId = "";
  let shapeBId = "";
  let frameId = "";

  beforeEach(async () => {
    const dispose = await mountTestSession("edgeless");
    const root = getEdgelessRoot(doc, editor, "edgeless");
    service = root.service;

    noteAId = insertTestNote(doc, { index: service.generateIndex() });
    shapeAId = service.crud.addElement("shape", {
      type: "rect",
      xywh: "[0, 0, 100, 100]",
      index: service.generateIndex(),
    })!;
    noteBId = insertTestNote(doc, { index: service.generateIndex() });
    shapeBId = service.crud.addElement("shape", {
      type: "rect",
      xywh: "[100, 0, 100, 100]",
      index: service.generateIndex(),
    })!;
    await flushFrame();

    frameId = service.crud.addBlock(
      "myoxus:frame",
      {
        xywh: "[0, 0, 800, 200]",
        index: service.generateIndex(),
      },
      service.surface.id,
    );

    return dispose;
  });

  test("renders frame preview with ordered notes/canvases and tracks target xywh updates", async () => {
    const refId = doc.addBlock(
      "myoxus:surface-ref",
      { reference: frameId, refFlavour: "myoxus:frame" },
      noteAId,
    );

    editor.mode = "page";
    await flushFrame();

    const surfaceRef = document.querySelector<SurfaceRefBlockComponent>(
      `myoxus-surface-ref[data-block-id="${refId}"]`,
    );
    expect(surfaceRef).toBeInstanceOf(Element);

    const refNotes = Array.from(
      surfaceRef!.querySelectorAll<HTMLElement>("myoxus-edgeless-note"),
    );
    const canvases = Array.from(
      surfaceRef!.querySelectorAll<HTMLCanvasElement>(".indexable-canvas"),
    );
    expect(refNotes).toHaveLength(2);
    expect(canvases).toHaveLength(2);
    expect(Number(canvases[0].style.zIndex)).toBeGreaterThan(
      Number(refNotes[0].style.zIndex),
    );

    const previewEdgeless =
      surfaceRef!.previewEditor!.std.get(EdgelessRootService);
    const previewFrame =
      surfaceRef!.querySelector<FrameBlockComponent>("myoxus-frame")!;
    expect(
      previewEdgeless.viewport.isInViewport(previewFrame.model.elementBound),
    ).toBe(true);

    const boundsBefore = previewEdgeless.viewport.viewportBounds;
    previewFrame.model.xywh = "[100, 100, 800, 200]";
    await flushFrame();
    expect(previewEdgeless.viewport.viewportBounds).not.toEqual(boundsBefore);
  });

  test("renders group preview and viewInEdgeless() focuses the referenced group in edgeless viewport", async () => {
    const groupId = service.crud.addElement("group", {
      children: {
        [shapeAId]: true,
        [shapeBId]: true,
        [noteAId]: true,
        [noteBId]: true,
      },
    })!;
    const refId = doc.addBlock(
      "myoxus:surface-ref",
      { reference: groupId, refFlavour: "group" },
      noteAId,
    );

    editor.mode = "page";
    await flushFrame();

    const surfaceRef = document.querySelector<SurfaceRefBlockComponent>(
      `myoxus-surface-ref[data-block-id="${refId}"]`,
    )!;
    expect(surfaceRef).toBeInstanceOf(Element);
    expect(surfaceRef.querySelector(".ref-placeholder")).toBeNull();

    const previewEdgeless =
      surfaceRef.previewEditor!.std.get(EdgelessRootService);
    const previewGroup = previewEdgeless.crud.getElementById(groupId)!;
    expect(
      previewEdgeless.viewport.isInViewport(previewGroup.elementBound),
    ).toBe(true);

    surfaceRef.viewInEdgeless();
    await editor.updateComplete;
    await flushFrame(50);

    expect(editor.mode).toBe("edgeless");
    const liveEdgeless = getEdgelessRoot(doc, editor, "edgeless").service;
    const liveGroup = liveEdgeless.crud.getElementById(groupId)!;
    expect(liveEdgeless.viewport.isInViewport(liveGroup.elementBound)).toBe(
      true,
    );
  });

  test("renders edgeless placeholder inside an edgeless note and for missing references", async () => {
    const validRefId = doc.addBlock(
      "myoxus:surface-ref",
      { reference: frameId, refFlavour: "myoxus:frame" },
      noteAId,
    );
    const missingRefId = doc.addBlock(
      "myoxus:surface-ref",
      { reference: "deleted-frame-id", refFlavour: "myoxus:frame" },
      noteAId,
    );
    await flushFrame();

    // In edgeless mode, surface-ref blocks inside notes render via the generic edgeless placeholder.
    const edgelessRef = document.querySelector(
      `myoxus-edgeless-surface-ref[data-block-id="${validRefId}"]`,
    );
    expect(edgelessRef).toBeInstanceOf(Element);

    // Switching to page mode renders the unavailable placeholder for a missing target.
    editor.mode = "page";
    await flushFrame();
    const missingRef = document.querySelector(
      `myoxus-surface-ref[data-block-id="${missingRefId}"]`,
    );
    expect(missingRef).toBeInstanceOf(Element);
    expect(missingRef!.querySelector("surface-ref-placeholder")).not.toBeNull();
  });
});
