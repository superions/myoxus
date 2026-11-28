// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EdgelessLegacySlotIdentifier,
  SurfaceBlockSchemaExtension,
} from "@virgultum/canvas-runtime/surface";
import {
  FrameBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/core/models";
import type { EditorHost } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { DocModeProvider, EditPropsStore } from "@virgultum/core/services";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { FrameNavigatorController } from "../frame-navigator-controller";

function createFixture(mode: "page" | "edgeless" = "edgeless") {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = [
    RootBlockSchemaExtension,
    SurfaceBlockSchemaExtension,
    FrameBlockSchemaExtension,
  ];
  workspace.meta.initialize();
  const doc = workspace.createDoc("frames-doc");
  doc.load();
  const store = doc.getStore();
  const rootId = store.addBlock("myoxus:page");
  const surfaceId = store.addBlock("myoxus:surface", {}, rootId);

  const frameA = store.addBlock(
    "myoxus:frame",
    {
      title: new Text("Intro"),
      xywh: "[0,0,400,300]",
      presentationIndex: "a0",
    },
    surfaceId,
  );
  const frameB = store.addBlock(
    "myoxus:frame",
    {
      title: new Text("Summary"),
      xywh: "[500,0,400,300]",
      presentationIndex: "a1",
    },
    surfaceId,
  );

  const storage = new Map<string, unknown>();
  const selectionSet = vi.fn();
  const setViewportByBound = vi.fn();
  const setTool = vi.fn();
  const setEditorMode = vi.fn();
  let currentMode = mode;
  const navigatorSettingUpdated = new Subject<{
    blackBackground?: boolean;
    fillScreen?: boolean;
    hideToolbar?: boolean;
  }>();

  const serviceMap = new Map<unknown, unknown>([
    [
      GfxControllerIdentifier,
      {
        selection: { set: selectionSet },
        viewport: { setViewportByBound },
        tool: { setTool },
      },
    ],
    [
      DocModeProvider,
      {
        getEditorMode: () => currentMode,
        setEditorMode: (next: "page" | "edgeless") => {
          currentMode = next;
          setEditorMode(next);
        },
      },
    ],
    [
      EditPropsStore,
      {
        getStorage: (key: string) => storage.get(key),
        setStorage: (key: string, value: unknown) => storage.set(key, value),
      },
    ],
    [EdgelessLegacySlotIdentifier, { navigatorSettingUpdated }],
  ]);

  const editor = {
    store,
    std: {
      get: (id: unknown) => serviceMap.get(id),
      getOptional: (id: unknown) => serviceMap.get(id),
    },
  } as unknown as EditorHost;

  return {
    workspace,
    store,
    rootId,
    frameA,
    frameB,
    editor,
    storage,
    selectionSet,
    setViewportByBound,
    setEditorMode,
    navigatorSettingUpdated,
  };
}

describe("FrameNavigatorController", () => {
  test("tracks frame ordering, live renames, and selection mirroring", () => {
    const fx = createFixture("edgeless");
    try {
      const controller = new FrameNavigatorController(fx.editor, {
        fitPadding: [20, 20, 20, 20],
      });
      const listener = vi.fn();
      const unsubscribe = controller.subscribe(listener);
      try {
        expect(controller.getSnapshot().frames.map((f) => f.title)).toEqual([
          "Intro",
          "Summary",
        ]);

        controller.select(fx.frameA, false);
        expect(controller.getSnapshot().selectedIds).toEqual([fx.frameA]);
        expect(fx.selectionSet).toHaveBeenLastCalledWith({
          elements: [fx.frameA],
          editing: false,
        });

        controller.select(fx.frameB, true);
        expect(controller.getSnapshot().selectedIds).toEqual([
          fx.frameA,
          fx.frameB,
        ]);

        controller.renameFrame(fx.frameA, "Agenda");
        expect(controller.getSnapshot().frames[0].title).toBe("Agenda");

        controller.clearSelection();
        expect(controller.getSnapshot().selectedIds).toEqual([]);
      } finally {
        unsubscribe();
      }
    } finally {
      fx.workspace.dispose();
    }
  });

  test("reorders frames via presentationIndex and persists settings", () => {
    const fx = createFixture("edgeless");
    try {
      const controller = new FrameNavigatorController(fx.editor);
      const unsubscribe = controller.subscribe(() => {});
      try {
        controller.reorderFrames([fx.frameB], 0);
        expect(controller.getSnapshot().frames.map((f) => f.id)).toEqual([
          fx.frameB,
          fx.frameA,
        ]);

        controller.setSetting("fillScreen", true);
        controller.setSetting("darkBackground", false);
        controller.setSetting("hideToolbar", true);
        expect(controller.getSnapshot().settings).toEqual({
          fillScreen: true,
          darkBackground: false,
          hideToolbar: true,
        });
        expect(fx.storage.get("presentFillScreen")).toBe(true);
        expect(fx.storage.get("presentBlackBackground")).toBe(false);
        expect(fx.storage.get("presentHideToolbar")).toBe(true);
      } finally {
        unsubscribe();
      }
    } finally {
      fx.workspace.dispose();
    }
  });

  test("fits viewport in edgeless mode and hands off viewport from page mode", () => {
    const fx = createFixture("edgeless");
    try {
      const controller = new FrameNavigatorController(fx.editor, {
        fitPadding: [10, 20, 30, 40],
      });
      controller.fitFrame(fx.frameA);
      expect(fx.setViewportByBound).toHaveBeenCalledTimes(1);
      expect(fx.setViewportByBound.mock.calls[0][1]).toEqual([10, 20, 30, 40]);

      const pageFx = createFixture("page");
      try {
        const pageController = new FrameNavigatorController(pageFx.editor, {
          fitPadding: [12, 12, 12, 12],
        });
        pageController.fitFrame(pageFx.frameB);
        expect(pageFx.setEditorMode).toHaveBeenCalledWith("edgeless");
        expect(pageFx.storage.get("viewport")).toMatchObject({
          referenceId: pageFx.frameB,
          padding: [12, 12, 12, 12],
        });
      } finally {
        pageFx.workspace.dispose();
      }
    } finally {
      fx.workspace.dispose();
    }
  });
});
