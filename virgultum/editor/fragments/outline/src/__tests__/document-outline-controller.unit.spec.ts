// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  NoteBlockSchemaExtension,
  type NoteBlockModel,
  NoteDisplayMode,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/model";
import { DocModeProvider } from "@virgultum/shared/services";
import type { EditorHost } from "@virgultum/std";
import { Text } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { afterEach, expect, test, vi } from "vitest";
import { outlineSettingsKey } from "../config";
import { DocumentOutlineController } from "../document-outline-controller";

afterEach(() => vi.unstubAllGlobals());

test.each(["page", "edgeless"])(
  "compact %s outline stays navigation-only despite stored sorting preferences",
  (mode) => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === outlineSettingsKey
          ? JSON.stringify({ showIcons: true, enableSorting: true })
          : null,
      setItem: vi.fn(),
    });
    const workspace = new TestWorkspace();
    workspace.storeExtensions = [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
    ];
    workspace.meta.initialize();
    const doc = workspace.createDoc("outline");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const heading = store.addBlock(
        "myoxus:paragraph",
        { type: "h2", text: new Text("Authored hierarchy") },
        note,
      );
      const exec = vi.fn();
      const draggable = vi.fn((_options: { canDrag: () => boolean }) =>
        vi.fn(),
      );
      const dropTarget = vi.fn(
        (_options: { canDrop: (args: unknown) => boolean }) => vi.fn(),
      );
      const editor = {
        store,
        std: {
          get: (id: unknown) =>
            id === DocModeProvider
              ? { getEditorMode: () => mode }
              : { selection: { selectedIds: [] } },
          getOptional: () => undefined,
          command: { exec },
          dnd: { draggable, dropTarget },
        },
      } as unknown as EditorHost;
      const controls = new DocumentOutlineController(editor, {
        compactWindowRadius: 4,
        hideHeader: true,
      });
      controls.toggleSorting();
      controls.changeMode(note, NoteDisplayMode.EdgelessOnly);
      const cleanup = controls.bindNote(document.createElement("div"), note);
      try {
        expect(controls.getSnapshot()).toMatchObject({
          sorting: false,
          showIcons: true,
          notes: [],
          entries: [{ id: heading, label: "Authored hierarchy", level: 1 }],
        });
        expect(draggable.mock.calls[0][0].canDrag()).toBe(false);
        expect(dropTarget.mock.calls[0][0].canDrop({ source: {} })).toBe(false);
        expect(exec).not.toHaveBeenCalled();
        expect(
          store.getModelById<NoteBlockModel>(note)?.props.displayMode,
        ).toBe(NoteDisplayMode.DocAndEdgeless);
      } finally {
        cleanup();
      }
    } finally {
      workspace.dispose();
    }
  },
);
