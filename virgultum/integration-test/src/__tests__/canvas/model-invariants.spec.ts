// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EdgelessRootBlockComponent } from "@virgultum/editor/blocks/root";
import type { SurfaceBlockModel } from "@virgultum/editor/blocks/surface";
import {
  type BrushElementModel,
  type ConnectorElementModel,
  type GroupElementModel,
  LocalShapeElementModel,
  NoteDisplayMode,
} from "@virgultum/editor/model";
import { Text } from "@virgultum/editor/store";
import { beforeEach, describe, expect, test } from "vitest";
import * as Y from "yjs";

import { flushFrame } from "../../harness/pointer.js";
import {
  getEdgelessRoot,
  getMountedSurface,
  insertTestNote,
  mountTestSession,
} from "../../harness/session.js";

describe("edgeless model invariants", () => {
  let surface!: SurfaceBlockModel;
  let service!: EdgelessRootBlockComponent["service"];

  beforeEach(async () => {
    const dispose = await mountTestSession("edgeless");
    surface = getMountedSurface(window.doc, window.editor).model;
    service = getEdgelessRoot(window.doc, window.editor, "edgeless").service;
    return dispose;
  });

  test("boots edgeless harness globals and mounted surface", () => {
    expect(window.doc).toBeDefined();
    expect(window.editor).toBeDefined();
    expect(window.editor.mode).toBe("edgeless");
    expect(surface).toBeDefined();
  });

  describe("isEmpty() semantics across blocks, surface, and document", () => {
    test("tracks paragraph emptiness across text and nested blocks", () => {
      const noteId = insertTestNote(doc);
      const emptyId = doc.addBlock("myoxus:paragraph", {}, noteId);
      expect(doc.getBlock(emptyId)?.model.isEmpty()).toBe(true);

      const textId = doc.addBlock(
        "myoxus:paragraph",
        { text: new Text("non-empty") },
        noteId,
      );
      expect(doc.getBlock(textId)?.model.isEmpty()).toBe(false);

      const parentId = doc.addBlock("myoxus:paragraph", {}, noteId);
      doc.addBlock("myoxus:paragraph", {}, parentId);
      expect(doc.getBlock(parentId)?.model.isEmpty()).toBe(false);
    });

    test("tracks note emptiness with zero, one empty, or multiple children", () => {
      const noteId = insertTestNote(doc);
      const note = doc.getBlock(noteId)!.model;
      expect(note.isEmpty()).toBe(true);

      for (const child of note.children.slice()) doc.deleteBlock(child);
      expect(note.children).toHaveLength(0);
      expect(note.isEmpty()).toBe(true);

      doc.addBlock("myoxus:paragraph", {}, noteId);
      expect(note.isEmpty()).toBe(true);

      doc.addBlock("myoxus:paragraph", {}, noteId);
      expect(note.isEmpty()).toBe(false);
    });

    test("tracks surface emptiness for persisted elements, frames, and local shapes", () => {
      expect(surface.isEmpty()).toBe(true);

      const shapeId = surface.addElement({ type: "shape" });
      expect(surface.isEmpty()).toBe(false);
      surface.deleteElement(shapeId);
      expect(surface.isEmpty()).toBe(true);

      const frameId = doc.addBlock("myoxus:frame", {}, surface.id);
      expect(surface.isEmpty()).toBe(false);
      doc.deleteBlock(doc.getBlock(frameId)!.model);
      expect(surface.isEmpty()).toBe(true);

      surface.addLocalElement(new LocalShapeElementModel(surface));
      expect(surface.isEmpty()).toBe(true);
    });

    test("tracks document emptiness across notes, paragraphs, and canvas elements", () => {
      expect(doc.isEmpty).toBe(true);
      expect(editor.rootModel.isEmpty()).toBe(true);

      const firstNoteId = insertTestNote(doc);
      const firstNote = doc.getBlock(firstNoteId)!.model;
      expect(doc.isEmpty).toBe(true);

      const secondNoteId = insertTestNote(doc);
      expect(doc.isEmpty).toBe(false);
      doc.deleteBlock(doc.getBlock(secondNoteId)!.model);
      expect(doc.isEmpty).toBe(true);

      const extraParaId = doc.addBlock("myoxus:paragraph", {}, firstNote);
      expect(doc.isEmpty).toBe(false);
      doc.deleteBlock(doc.getBlock(extraParaId)!.model);
      expect(doc.isEmpty).toBe(true);

      const shapeId = surface.addElement({ type: "shape" });
      expect(doc.isEmpty).toBe(false);
      surface.deleteElement(shapeId);
      expect(doc.isEmpty).toBe(true);
    });
  });

  describe("SurfaceBlockModel group, connector, and brush invariants", () => {
    test("resolves group membership across updates, plain objects, and deletion", () => {
      const emptyGroupId = surface.addElement({ type: "group" });
      const emptyGroup = surface.getElementById(
        emptyGroupId,
      ) as GroupElementModel;
      expect([emptyGroup.x, emptyGroup.y, emptyGroup.w, emptyGroup.h]).toEqual([
        0, 0, 0, 0,
      ]);

      const a = surface.addElement({ type: "shape" });
      const b = surface.addElement({ type: "shape" });
      const c = surface.addElement({ type: "shape" });
      const groupId = surface.addElement({
        type: "group",
        children: { [a]: true, [b]: true, [c]: true },
      });
      const group = surface.getElementById(groupId) as GroupElementModel;

      expect(surface.getGroup(a)).toBe(group);
      expect(surface.getElementById(a)!.group).toBe(group);

      surface.store.transact(() => {
        group.children.delete(a);
        group.children.delete(b);
      });
      expect(surface.getGroup(a)).toBeNull();
      expect(surface.getGroup(b)).toBeNull();
      expect(surface.getGroup(c)).toBe(group);

      surface.updateElement(groupId, { children: { [a]: false } });
      expect(group.childIds).toEqual([a]);

      surface.deleteElement(groupId);
      expect(surface.getGroup(a)).toBeNull();
    });

    test("maintains connector endpoint index across multi-link, retarget, stale cache, and delete", async () => {
      const s1 = surface.addElement({ type: "shape" });
      const s2 = surface.addElement({ type: "shape" });
      const s3 = surface.addElement({ type: "shape" });

      const c1 = surface.addElement({
        type: "connector",
        source: { id: s1 },
        target: { id: s2 },
      });
      const c2 = surface.addElement({
        type: "connector",
        source: { id: s1 },
        target: { id: s2 },
      });
      expect(surface.getConnectors(s1).map((c) => c.id)).toEqual([c1, c2]);
      expect(surface.getConnectors(s2).map((c) => c.id)).toEqual([c1, c2]);
      expect(
        (surface.getElementById(c1) as ConnectorElementModel).forceFullRender,
      ).toBe(true);

      // Retarget c1 source from s1 -> s3
      surface.updateElement(c1, { source: { id: s3 }, target: { id: s2 } });
      expect(surface.getConnectors(s1).map((c) => c.id)).toEqual([c2]);
      expect(surface.getConnectors(s3).map((c) => c.id)).toEqual([c1]);

      // Detach c1 completely
      surface.updateElement(c1, {
        source: { position: [0, 0] },
        target: { position: [0, 0] },
      });
      expect(surface.getConnectors(s3)).toEqual([]);

      // Delete c2 and verify index cleanup
      surface.deleteElement(c2);
      await flushFrame();
      expect(surface.getConnectors(s1)).toEqual([]);
      expect(surface.getConnectors(s2)).toEqual([]);

      // Inject a stale cache entry and ensure getConnectors purges it
      const internal = surface as unknown as {
        _connectorIdsByEndpoint: Map<string, Set<string>>;
        _connectorEndpoints: Map<
          string,
          { sourceId: string | null; targetId: string | null }
        >;
      };
      internal._connectorIdsByEndpoint.set(s1, new Set(["ghost-connector"]));
      internal._connectorEndpoints.set("ghost-connector", {
        sourceId: s1,
        targetId: null,
      });
      expect(surface.getConnectors(s1)).toEqual([]);
      expect(internal._connectorEndpoints.has("ghost-connector")).toBe(false);
    });

    test("restores brush xywh deterministically when lineWidth returns to original", () => {
      const brushId = surface.addElement({
        type: "brush",
        lineWidth: 2,
        points: [
          [0, 0],
          [100, 100],
          [120, 150],
        ],
      });
      const brush = surface.getElementById(brushId) as BrushElementModel;
      const original = brush.xywh;

      brush.lineWidth = 4;
      expect(brush.xywh).not.toBe(original);

      brush.lineWidth = 2;
      expect(brush.xywh).toBe(original);
    });
  });

  describe("GroupElementModel lifecycle, bounds, and cycle guard", () => {
    test("auto-removes group once all children are deleted and restores via undo/redo", () => {
      const children = new Y.Map<boolean>();
      const shapeA = service.crud.addElement("shape", { shapeType: "rect" })!;
      const shapeB = service.crud.addElement("shape", { shapeType: "rect" })!;
      const noteA = insertTestNote(doc);
      const noteB = insertTestNote(doc);
      for (const id of [shapeA, shapeB, noteA, noteB]) children.set(id, true);

      service.crud.addElement("group", { children });
      doc.captureSync();
      expect(service.elements).toHaveLength(3);

      service.removeElement(shapeA);
      service.removeElement(shapeB);
      doc.captureSync();
      expect(service.elements).toHaveLength(1);

      service.removeElement(noteA);
      service.removeElement(noteB);
      doc.captureSync();
      expect(service.elements).toHaveLength(0);

      doc.undo();
      expect(service.elements).toHaveLength(1);
      doc.redo();
      expect(service.elements).toHaveLength(0);
    });

    test("cascade-deletes group children and restores them on undo", () => {
      const noteId = insertTestNote(doc);
      const shapeId = service.crud.addElement("shape", { shapeType: "rect" })!;
      const children = new Y.Map<boolean>();
      children.set(noteId, true);
      children.set(shapeId, true);

      const groupId = service.crud.addElement("group", { children })!;
      expect(service.elements).toHaveLength(2);
      doc.captureSync();

      service.removeElement(groupId);
      expect(service.elements).toHaveLength(0);
      expect(doc.getBlock(noteId)).toBeUndefined();

      doc.undo();
      expect(doc.getBlock(noteId)).toBeDefined();
      expect(service.elements).toHaveLength(2);
    });

    test("recomputes group xywh dynamically across child edits, removals, and undo", async () => {
      const shape1 = service.crud.addElement("shape", {
        shapeType: "rect",
        xywh: "[0,0,100,100]",
      })!;
      const shape2 = service.crud.addElement("shape", {
        shapeType: "rect",
        xywh: "[100,100,100,100]",
      })!;
      const note1 = insertTestNote(doc, {
        displayMode: NoteDisplayMode.DocAndEdgeless,
        xywh: "[200,200,800,100]",
        edgeless: {
          style: {
            borderRadius: 8,
            borderSize: 4,
            borderStyle: "solid",
            shadowType: "--myoxus-note-shadow-box",
          },
          collapse: true,
          collapsedHeight: 100,
        },
      });
      const children = new Y.Map<boolean>();
      children.set(shape1, true);
      children.set(shape2, true);
      children.set(note1, true);

      const groupId = service.crud.addElement("group", { children })!;
      const group = service.crud.getElementById(groupId) as GroupElementModel;

      const expectBounds = (x: number, y: number, w: number, h: number) => {
        expect([group.x, group.y, group.w, group.h]).toEqual([x, y, w, h]);
      };

      doc.captureSync();
      await flushFrame();
      expectBounds(0, 0, 1000, 300);

      service.removeElement(note1);
      await flushFrame();
      expectBounds(0, 0, 200, 200);
      doc.captureSync();

      doc.undo();
      await flushFrame();
      expectBounds(0, 0, 1000, 300);

      service.crud.updateElement(note1, { xywh: "[300,300,800,100]" });
      await flushFrame();
      expectBounds(0, 0, 1100, 400);
      doc.captureSync();

      doc.undo();
      await flushFrame();
      expectBounds(0, 0, 1000, 300);

      service.crud.updateElement(shape1, { xywh: "[100,100,100,100]" });
      await flushFrame();
      expectBounds(100, 100, 900, 200);
      doc.captureSync();

      doc.undo();
      await flushFrame();
      expectBounds(0, 0, 1000, 300);
    });

    test("prevents cyclic group ancestry in descendantElements", () => {
      const groups = [0, 1, 2].map(() => {
        const id = service.crud.addElement("group", {
          children: new Y.Map<boolean>(),
        })!;
        return service.crud.getElementById(id) as GroupElementModel;
      });

      groups[0].addChild(groups[1]);
      groups[1].addChild(groups[2]);
      groups[2].addChild(groups[0]);

      expect(groups[0].descendantElements).toHaveLength(2);
      expect(groups[1].descendantElements).toHaveLength(1);
      expect(groups[2].descendantElements).toHaveLength(0);
    });
  });
});
