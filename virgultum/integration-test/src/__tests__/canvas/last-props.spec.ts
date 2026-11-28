// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import "../../../../../client/branding/theme-fallback.css";

import {
  getMermaidVisualModel,
  insertMermaidEdgelessDiagramCommand,
  MindmapDesign,
  MindmapLayoutType,
  prepareMermaidFamilySource,
  readMindmapProjectionOptions,
} from "@virgultum/editor/blocks/mermaid";
import type { EdgelessRootBlockComponent } from "@virgultum/editor/blocks/root";
import { getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import {
  type BrushElementModel,
  type ConnectorElementModel,
  DEFAULT_NOTE_SHADOW,
  DefaultTheme,
  type EdgelessTextBlockModel,
  FontFamily,
  type FrameBlockModel,
  type MermaidBlockModel,
  type NoteBlockModel,
  NoteShadow,
  type ShapeElementModel,
  ShapeType,
  type TextElementModel,
} from "@virgultum/editor/model";
import { EditPropsStore } from "@virgultum/editor/shared/services";
import type { BlockStdScope } from "@virgultum/editor/std";
import { beforeEach, describe, expect, test } from "vitest";

import { getEdgelessRoot, mountTestSession } from "../../harness/session.js";

describe("EditPropsStore sticky defaults", () => {
  let service!: EdgelessRootBlockComponent["service"];
  let std!: BlockStdScope;

  beforeEach(async () => {
    sessionStorage.removeItem("virgultum:prop:record");
    const dispose = await mountTestSession("edgeless");
    const root = getEdgelessRoot(window.doc, window.editor, "edgeless");
    service = root.service;
    std = root.std;
    return dispose;
  });

  test("remembers fillColor independently for rect, diamond, and roundedRect shapes", () => {
    const variants = [
      {
        label: "rect",
        props: { shapeType: ShapeType.Rect },
        storeKey: `shape:${ShapeType.Rect}` as const,
        updatedColor: DefaultTheme.FillColorShortMap.Orange,
      },
      {
        label: "diamond",
        props: { shapeType: ShapeType.Diamond },
        storeKey: `shape:${ShapeType.Diamond}` as const,
        updatedColor: DefaultTheme.FillColorShortMap.Blue,
      },
      {
        label: "roundedRect",
        props: { shapeType: ShapeType.Rect, radius: 0.1 },
        storeKey: "shape:roundedRect" as const,
        updatedColor: DefaultTheme.FillColorShortMap.Green,
      },
    ];

    for (const v of variants) {
      const id = service.crud.addElement("shape", v.props)!;
      const first = service.crud.getElementById(id) as ShapeElementModel;
      expect(first.fillColor, v.label).toBe(DefaultTheme.shapeFillColor);

      service.crud.updateElement(id, { fillColor: v.updatedColor });
      expect(
        std.get(EditPropsStore).lastProps$.value[v.storeKey].fillColor,
      ).toBe(v.updatedColor);
    }

    for (const v of variants) {
      const nextId = service.crud.addElement("shape", v.props)!;
      const next = service.crud.getElementById(nextId) as ShapeElementModel;
      expect(next.fillColor, v.label).toBe(v.updatedColor);
    }
  });

  test("remembers connector strokeWidth and labelStyle across modes", () => {
    const id1 = service.crud.addElement("connector", { mode: 0 })!;
    const first = service.crud.getElementById(id1) as ConnectorElementModel;
    expect(first.stroke).toBe(DefaultTheme.connectorColor);
    expect(first.strokeWidth).toBe(2);
    expect(first.strokeStyle).toBe("solid");
    expect(first.frontEndpointStyle).toBe("None");
    expect(first.rearEndpointStyle).toBe("Arrow");

    service.crud.updateElement(id1, { strokeWidth: 10 });
    const id2 = service.crud.addElement("connector", { mode: 1 })!;
    expect(
      (service.crud.getElementById(id2) as ConnectorElementModel).strokeWidth,
    ).toBe(10);

    service.crud.updateElement(id2, {
      labelStyle: { color: DefaultTheme.black, fontFamily: FontFamily.Kalam },
    });
    const id3 = service.crud.addElement("connector", { mode: 1 })!;
    const third = service.crud.getElementById(id3) as ConnectorElementModel;
    expect(third.strokeWidth).toBe(10);
    expect(third.labelStyle.color).toEqual(DefaultTheme.black);
    expect(third.labelStyle.fontFamily).toBe(FontFamily.Kalam);
  });

  test("remembers brush lineWidth and canvas text fontSize", () => {
    const brushId = service.crud.addElement("brush", {})!;
    const brush = service.crud.getElementById(brushId) as BrushElementModel;
    expect(brush.color).toEqual(DefaultTheme.black);
    expect(brush.lineWidth).toBe(4);
    service.crud.updateElement(brushId, { lineWidth: 10 });
    const nextBrush = service.crud.getElementById(
      service.crud.addElement("brush", {})!,
    ) as BrushElementModel;
    expect(nextBrush.lineWidth).toBe(10);

    const textId = service.crud.addElement("text", {})!;
    expect(
      (service.crud.getElementById(textId) as TextElementModel).fontSize,
    ).toBe(24);
    service.crud.updateElement(textId, { fontSize: 36 });
    const nextText = service.crud.getElementById(
      service.crud.addElement("text", {})!,
    ) as TextElementModel;
    expect(nextText.fontSize).toBe(36);
  });

  test("remembers Mermaid mindmap layoutType and style defaults", async () => {
    const source = "mindmap\nroot\n  child\n";
    await prepareMermaidFamilySource(source);

    const insertMindmap = () => {
      const [ok, ctx] = std.command.exec(insertMermaidEdgelessDiagramCommand, {
        source,
      });
      expect(ok).toBe(true);
      const owner = doc.getBlock(ctx.insertedMermaidDiagram!.blockId)!
        .model as MermaidBlockModel;
      return readMindmapProjectionOptions(getMermaidVisualModel(owner)!);
    };

    expect(insertMindmap()).toMatchObject({
      layout: MindmapLayoutType.RIGHT,
      design: MindmapDesign.ONE,
    });

    std.get(EditPropsStore).recordLastProps("mindmap", {
      layoutType: MindmapLayoutType.BALANCE,
      style: MindmapDesign.THREE,
    });
    expect(insertMindmap()).toMatchObject({
      layout: MindmapLayoutType.BALANCE,
      design: MindmapDesign.THREE,
    });
  });

  test("remembers edgeless-text, note, and frame block defaults", () => {
    const surface = getSurfaceBlock(doc)!;

    // Edgeless text
    const et1 = service.crud.addBlock("myoxus:edgeless-text", {}, surface.id)!;
    const etModel1 = service.crud.getElementById(et1) as EdgelessTextBlockModel;
    expect(etModel1.props.color).toStrictEqual(DefaultTheme.textColor);
    expect(etModel1.props.fontFamily).toBe(FontFamily.Inter);
    service.crud.updateElement(et1, {
      color: DefaultTheme.StrokeColorShortMap.Green,
      fontFamily: FontFamily.OrelegaOne,
    });
    const et2 = service.crud.addBlock("myoxus:edgeless-text", {}, surface.id)!;
    const etModel2 = service.crud.getElementById(et2) as EdgelessTextBlockModel;
    expect(etModel2.props.color).toBe(DefaultTheme.StrokeColorShortMap.Green);
    expect(etModel2.props.fontFamily).toBe(FontFamily.OrelegaOne);

    // Note
    const note1 = service.crud.addBlock("myoxus:note", {}, doc.root!.id)!;
    const noteModel1 = service.crud.getElementById(note1) as NoteBlockModel;
    expect(noteModel1.props.background).toEqual(
      DefaultTheme.noteBackgrounColor,
    );
    expect(noteModel1.props.edgeless.style.shadowType).toBe(
      DEFAULT_NOTE_SHADOW,
    );
    service.crud.updateElement(note1, {
      background: DefaultTheme.NoteBackgroundColorMap.Purple,
      edgeless: { style: { shadowType: NoteShadow.Film } },
    });
    const note2 = service.crud.addBlock("myoxus:note", {}, doc.root!.id)!;
    const noteModel2 = service.crud.getElementById(note2) as NoteBlockModel;
    expect(noteModel2.props.background).toEqual(
      DefaultTheme.NoteBackgroundColorMap.Purple,
    );
    expect(noteModel2.props.edgeless.style.shadowType).toBe(NoteShadow.Film);

    // Frame across string, single-value object, and light/dark object backgrounds
    const f1 = service.crud.addBlock("myoxus:frame", {}, surface.id)!;
    expect(
      (service.crud.getElementById(f1) as FrameBlockModel).props.background,
    ).toBe("transparent");
    service.crud.updateElement(f1, {
      background: DefaultTheme.StrokeColorShortMap.Purple,
    });
    const f2 = service.crud.addBlock("myoxus:frame", {}, surface.id)!;
    expect(
      (service.crud.getElementById(f2) as FrameBlockModel).props.background,
    ).toBe(DefaultTheme.StrokeColorShortMap.Purple);
    service.crud.updateElement(f2, { background: { normal: "#def4e740" } });
    const f3 = service.crud.addBlock("myoxus:frame", {}, surface.id)!;
    expect(
      (service.crud.getElementById(f3) as FrameBlockModel).props.background,
    ).toEqual({ normal: "#def4e740" });
    service.crud.updateElement(f3, {
      background: { light: "#a381aa23", dark: "#6e907452" },
    });
    const f4 = service.crud.addBlock("myoxus:frame", {}, surface.id)!;
    expect(
      (service.crud.getElementById(f4) as FrameBlockModel).props.background,
    ).toEqual({ light: "#a381aa23", dark: "#6e907452" });
  });
});
