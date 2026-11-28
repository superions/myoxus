// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EdgelessRootBlockComponent } from "@virgultum/editor/blocks/root";
import type {
  CanvasRenderer,
  SurfaceElementModel,
} from "@virgultum/editor/blocks/surface";
import { ungroupCommand } from "@virgultum/editor/gfx/group";
import type {
  GroupElementModel,
  NoteBlockModel,
} from "@virgultum/editor/model";
import { generateKeyBetween } from "@virgultum/editor/std/gfx";
import { beforeEach, describe, expect, test } from "vitest";
import * as Y from "yjs";

import { flushFrame } from "../../harness/pointer.js";
import {
  getEdgelessRoot,
  getMountedSurface,
  insertTestNote,
  mountTestSession,
} from "../../harness/session.js";

describe("LayerManager ordering and DOM projection", () => {
  let service!: EdgelessRootBlockComponent["service"];

  const addIndexedNote = (props: Record<string, unknown> = {}) =>
    insertTestNote(doc, { index: service.layer.generateIndex(), ...props });

  const createGroup = (childIds: string[]) => {
    const children = new Y.Map<boolean>();
    for (const id of childIds) children.set(id, true);
    return service.crud.addElement("group", { children })!;
  };

  const layerIndexOf = (id: string) =>
    service.layer.layers.findIndex((layer) =>
      layer.set.has(service.crud.getElementById(id) as never),
    );

  beforeEach(async () => {
    const dispose = await mountTestSession("edgeless");
    service = getEdgelessRoot(window.doc, window.editor, "edgeless").service;
    return async () => {
      await flushFrame(100);
      dispose();
    };
  });

  test("splits, merges, and counts canvasLayers across insertions and deletions", async () => {
    expect(service.layer.layers).toHaveLength(0);
    expect(service.layer.canvasLayers).toHaveLength(1);

    const n1 = addIndexedNote();
    expect(service.layer.canvasLayers).toHaveLength(1);

    const s1 = service.crud.addElement("shape", { shapeType: "rect" })!;
    const n2 = addIndexedNote();
    const s2 = service.crud.addElement("shape", { shapeType: "rect" })!;
    await flushFrame();

    expect(service.layer.layers).toHaveLength(4);
    expect(service.layer.layers.at(-1)?.type).toBe("canvas");
    expect(service.layer.canvasLayers).toHaveLength(2);

    // Adding a block above the top canvas layer reserves an extra trailing canvas slot.
    const n3 = addIndexedNote();
    expect(service.layer.canvasLayers).toHaveLength(3);

    for (const id of [n3, s2, n2, s1]) service.removeElement(id);
    expect(service.layer.layers).toHaveLength(1);
    service.removeElement(n1);
    expect(service.layer.layers).toHaveLength(0);
  });

  test("updates layer zIndex on reorder and restores on undo", async () => {
    addIndexedNote();
    const middleNoteId = addIndexedNote();
    const middleNote = service.crud.getElementById(middleNoteId)!;
    addIndexedNote();
    service.crud.addElement("shape", { shapeType: "rect" });
    const topShapeId = service.crud.addElement("shape", { shapeType: "rect" })!;
    const topShape = service.crud.getElementById(topShapeId)!;
    await flushFrame();

    const assertStep0 = () => {
      expect(service.layer.layers[0]).toMatchObject({
        type: "block",
        zIndex: 1,
      });
      expect(service.layer.layers[1]).toMatchObject({
        type: "canvas",
        zIndex: 4,
      });
    };
    assertStep0();
    service.doc.captureSync();

    service.crud.updateElement(middleNoteId, {
      index: service.layer.getReorderedIndex(middleNote, "front"),
    });
    await flushFrame();
    service.doc.captureSync();

    const assertStep1 = () => {
      expect(service.layer.layers[1]).toMatchObject({
        type: "canvas",
        zIndex: 3,
      });
      expect(service.layer.layers[2]).toMatchObject({
        type: "block",
        zIndex: 5,
      });
    };
    assertStep1();

    service.crud.updateElement(topShapeId, {
      index: service.layer.getReorderedIndex(topShape, "front"),
    });
    await flushFrame();
    service.doc.captureSync();
    expect(service.layer.layers[3]).toMatchObject({
      type: "canvas",
      zIndex: 5,
    });

    service.doc.undo();
    await flushFrame();
    assertStep1();

    service.doc.undo();
    await flushFrame();
    assertStep0();
  });

  test("preserves rendered block subtrees when splitting block layers", async () => {
    const notes = [0, 1, 2, 3].map(() => addIndexedNote());
    const assertRendered = () => {
      const els = Array.from(
        document.querySelectorAll(
          "myoxus-edgeless-root gfx-viewport > [data-block-id]",
        ),
      );
      expect(els).toHaveLength(5);
      for (const el of els) expect(el.children.length).toBeGreaterThan(0);
    };

    await flushFrame();
    assertRendered();

    service.crud.addElement("shape", {
      shapeType: "rect",
      index: generateKeyBetween(
        service.crud.getElementById(notes[1])!.index,
        service.crud.getElementById(notes[2])!.index,
      ),
    });
    await flushFrame();
    assertRendered();
  });

  test("supports forward, front, backward, and back layer reorder operations", async () => {
    const ids = [
      service.crud.addElement("shape", { shapeType: "rect" })!,
      addIndexedNote(),
      service.crud.addElement("shape", { shapeType: "rect" })!,
      addIndexedNote(),
    ];

    service.crud.updateElement(ids[0], {
      index: service.layer.getReorderedIndex(
        service.crud.getElementById(ids[0])!,
        "forward",
      ),
    });
    expect(layerIndexOf(ids[0])).toBe(1);
    expect(layerIndexOf(ids[1])).toBe(0);

    await flushFrame();
    service.crud.updateElement(ids[0], {
      index: service.layer.getReorderedIndex(
        service.crud.getElementById(ids[0])!,
        "front",
      ),
    });
    expect(layerIndexOf(ids[0])).toBe(service.layer.layers.length - 1);

    await flushFrame();
    service.crud.updateElement(ids[3], {
      index: service.layer.getReorderedIndex(
        service.crud.getElementById(ids[3])!,
        "backward",
      ),
    });
    expect(layerIndexOf(ids[3])).toBeLessThan(layerIndexOf(ids[2]));

    await flushFrame();
    service.crud.updateElement(ids[3], {
      index: service.layer.getReorderedIndex(
        service.crud.getElementById(ids[3])!,
        "back",
      ),
    });
    expect(layerIndexOf(ids[3])).toBe(0);
  });

  test("updates canvas layers and DOM zIndex on group creation, reorder, ungroup, and undo", async () => {
    const edgeless = getEdgelessRoot(doc, editor, "edgeless");
    const ids = [
      service.crud.addElement("shape", { shapeType: "rect" })!,
      addIndexedNote(),
      service.crud.addElement("shape", { shapeType: "rect" })!,
      addIndexedNote(),
      service.crud.addElement("shape", { shapeType: "rect" })!,
    ];
    await flushFrame();
    const initialCanvases =
      edgeless.querySelectorAll<HTMLCanvasElement>(".indexable-canvas");
    expect(initialCanvases).toHaveLength(2);
    for (const c of initialCanvases) {
      expect(c.getBoundingClientRect().width).toBeGreaterThan(0);
    }

    const shapeGroupId = createGroup([ids[0], ids[2], ids[4]]);
    expect(service.layer.layers).toHaveLength(2);
    expect(service.layer.layers[0]).toMatchObject({ type: "block" });
    expect(service.layer.layers[1]).toMatchObject({ type: "canvas" });
    expect(edgeless.querySelectorAll(".indexable-canvas")).toHaveLength(0);

    const topCanvasZ = Number(
      (edgeless.querySelector("myoxus-surface canvas") as HTMLElement).style
        .zIndex,
    );
    for (const noteId of [ids[1], ids[3]]) {
      const noteZ = Number(
        (edgeless.querySelector(`[data-block-id="${noteId}"]`) as HTMLElement)
          .style.zIndex,
      );
      expect(noteZ).toBeLessThan(topCanvasZ);
    }

    const shapeGroup = service.crud.getElementById(shapeGroupId)!;
    shapeGroup.index = service.layer.getReorderedIndex(shapeGroup, "back");
    expect(service.layer.layers[0].elements[0]).toBe(shapeGroup);

    shapeGroup.index = service.layer.getReorderedIndex(shapeGroup, "front");
    expect(service.layer.layers[1].elements[0]).toBe(shapeGroup);

    // Ungroup + undo/redo keeps monotonic element order
    service.doc.captureSync();
    const ordered = [ids[0], ids[2], ids[4]].map((id) =>
      service.crud.getElementById(id)!,
    );
    const isOrdered = () =>
      ordered.every(
        (el, idx) => idx === 0 || ordered[idx - 1].index < el.index,
      );

    service.std.command.exec(ungroupCommand, {
      group: shapeGroup as GroupElementModel,
    });
    expect(isOrdered()).toBe(true);
    service.doc.undo();
    expect(isOrdered()).toBe(true);
    service.doc.redo();
    expect(isOrdered()).toBe(true);
  });

  test("orders standalone and nested elements consistently via layer.compare", () => {
    const s1Id = service.crud.addElement("shape", { shapeType: "rect" })!;
    const n1Id = addIndexedNote();
    const innerA = createGroup([s1Id, n1Id]);
    const outerA = createGroup([innerA]);

    const s2Id = service.crud.addElement("shape", { shapeType: "rect" })!;
    const n2Id = addIndexedNote();
    const innerB = createGroup([s2Id, n2Id]);
    const outerB = createGroup([innerB]);

    const s1 = service.crud.getElementById(s1Id)!;
    const n1 = service.crud.getElementById(n1Id)!;
    const gA = service.crud.getElementById(outerA)!;
    const s2 = service.crud.getElementById(s2Id)!;
    const gB = service.crud.getElementById(outerB)!;

    expect(service.layer.compare(s1, s1)).toBe(0);
    expect(service.layer.compare(gA, s1)).toBe(-1);
    expect(service.layer.compare(s1, gA)).toBe(1);
    expect(service.layer.compare(s1, n1)).toBe(-1);
    expect(service.layer.compare(s1, s2)).toBe(-1);
    expect(service.layer.compare(gB, gA)).toBe(1);

    gB.index = service.layer.getReorderedIndex(gB, "back");
    expect(service.layer.compare(gB, gA)).toBe(-1);
    expect(service.layer.compare(s2, s1)).toBe(-1);
  });

  test("reinserts .indexable-canvas after mode switch and sorts fractional DOM zIndex", async () => {
    service.crud.addElement("shape", { shapeType: "rect" });
    addIndexedNote();
    await flushFrame();
    service.crud.addElement("shape", { shapeType: "rect" });

    editor.mode = "page";
    await flushFrame();
    editor.mode = "edgeless";
    await flushFrame();

    const surface = getMountedSurface(doc, editor);
    const edgeless = getEdgelessRoot(doc, editor, "edgeless");
    const canvases =
      edgeless.querySelectorAll<HTMLCanvasElement>(".indexable-canvas");
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(
      (surface.renderer as CanvasRenderer).canvas.width,
    );
    expect(canvases[0].height).toBe(
      (surface.renderer as CanvasRenderer).canvas.height,
    );
    expect(canvases[0].width).toBeGreaterThan(0);

    // Out-of-order fractional indexes should match computed DOM zIndex ascending
    const indexes = [
      "ao",
      "b0D",
      "ar",
      "as",
      "at",
      "b0Y",
      "b0H",
      "b0f",
      "b0fl",
    ];
    editor.mode = "page";
    await flushFrame();
    for (const index of indexes) insertTestNote(doc, { index });
    await flushFrame();

    editor.mode = "edgeless";
    await flushFrame(300);

    const refreshedRoot = getEdgelessRoot(doc, editor, "edgeless");
    const noteEls = Array.from(
      refreshedRoot.querySelectorAll<HTMLElement>(
        "gfx-viewport > [data-block-id]",
      ),
    ).flatMap((el) => {
      const m = doc.getModelById<NoteBlockModel>(el.dataset.blockId!);
      return m?.flavour === "myoxus:note" && indexes.includes(m.props.index)
        ? [{ index: m.props.index, z: Number(getComputedStyle(el).zIndex) }]
        : [];
    });

    expect(
      noteEls.sort((a, b) => a.z - b.z).map((entry) => entry.index),
    ).toEqual([...indexes].sort());
  });

  test("createIndexGenerator advances monotonically beyond pre-existing elements", () => {
    const shape = service.crud.getElementById(
      service.crud.addElement("shape", { shapeType: "rect" })!,
    )! as SurfaceElementModel;
    const note = service.crud.getElementById(
      addIndexedNote(),
    )! as NoteBlockModel;

    const nextIndex = service.layer.createIndexGenerator();
    const seq = [nextIndex(), nextIndex(), nextIndex(), nextIndex()];
    expect(seq[0] > shape.index).toBe(true);
    expect(seq[0] > note.index).toBe(true);
    expect(seq[1] > seq[0]).toBe(true);
    expect(seq[2] > seq[1]).toBe(true);
    expect(seq[3] > seq[2]).toBe(true);
  });
});
