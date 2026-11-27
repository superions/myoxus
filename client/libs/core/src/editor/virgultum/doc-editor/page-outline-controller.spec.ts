// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { LiveData } from "@myoxus/infra";
import {
  AnnotationBlockSchemaExtension,
  CalloutBlockSchemaExtension,
  FootnoteDefinitionBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  NoteDisplayMode,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  TableOfContentsBlockSchemaExtension,
} from "@virgultum/core/models";
import { getReadablePageHeadingBlocksFromStore } from "@virgultum/core/utils";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { describe, expect, test, vi } from "vitest";

import { createPageOutlineController } from "./page-outline-controller";

const LABELS = {
  title: "Table of Contents",
  emptyPlaceholder: "Empty",
  previewSettings: "Preview settings",
  visibilityAndSort: "Visibility and sort",
  hiddenContents: "Hidden contents",
  hiddenNoticeTitle: "Hidden",
  hiddenNoticeBody: "Hidden body",
  hiddenNoticeActionPrefix: "Open",
  hiddenNoticeActionSuffix: "to show",
  modeBoth: "Both",
  modeEdgeless: "Edgeless",
  modePage: "Page",
  next: "Next",
  previous: "Previous",
};

describe("createPageOutlineController", () => {
  test("projects headings from Store without EditorHost and reacts to live edits", () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
    ];
    workspace.meta.initialize();
    const doc = workspace.createDoc("outline-page");
    doc.load();
    const store = doc.getStore();
    const origin$ = new LiveData<HTMLElement | null>(null);

    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const h1 = store.addBlock(
        "myoxus:paragraph",
        { type: "h1", text: new Text("Introduction") },
        note,
      );
      store.addBlock(
        "myoxus:paragraph",
        { type: "h2", text: new Text("") },
        note,
      );
      const h2 = store.addBlock(
        "myoxus:paragraph",
        { type: "h2", text: new Text("Architecture") },
        note,
      );

      const controls = createPageOutlineController({
        store,
        origin$,
        labels: LABELS,
        resolveReference: (pageId) => ({ text: pageId, docId: pageId }),
        resolveMessage: (_key, fallback) => fallback,
        compactWindowRadius: 4,
        hideHeader: true,
      });

      const listener = vi.fn();
      const unsubscribe = controls.subscribe(listener);
      try {
        expect(controls.getSnapshot().entries).toEqual([
          expect.objectContaining({
            id: h1,
            label: "Introduction",
            level: 0,
            icon: "Heading1Icon",
          }),
          expect.objectContaining({
            id: h2,
            label: "Architecture",
            level: 1,
            icon: "Heading2Icon",
          }),
        ]);

        const h3 = store.addBlock(
          "myoxus:paragraph",
          { type: "h3", text: new Text("Verification") },
          note,
        );
        expect(controls.getSnapshot().entries.map((e) => e.id)).toEqual([
          h1,
          h2,
          h3,
        ]);

        // Scroll target lookup works against [data-block-id] inside nativeOrigin$
        const container = document.createElement("div");
        const target = document.createElement("div");
        target.setAttribute("data-block-id", h3);
        const scrollIntoView = vi.fn();
        target.scrollIntoView = scrollIntoView;
        container.append(target);
        origin$.next(container);

        controls.navigate(h3);
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: "smooth",
          block: "center",
        });
        expect(controls.getSnapshot().activeId).toBe(h3);
      } finally {
        unsubscribe();
      }
    } finally {
      workspace.dispose();
    }
  });

  test("projects readable Page headings deterministically with container allowlist, stop-list, level range, and duplicate IDs", () => {
    const workspace = new TestWorkspace({ id: "toc-scanner-spec" });
    workspace.meta.initialize();
    try {
      const doc = workspace.createDoc("toc-doc");
      doc.load();
      const store = doc.getStore({
        extensions: [
          RootBlockSchemaExtension,
          NoteBlockSchemaExtension,
          ParagraphBlockSchemaExtension,
          ListBlockSchemaExtension,
          CalloutBlockSchemaExtension,
          AnnotationBlockSchemaExtension,
          FootnoteDefinitionBlockSchemaExtension,
          TableOfContentsBlockSchemaExtension,
        ],
      });
      const rootId = store.addBlock("myoxus:page", {
        title: new Text("TOC Spec"),
      });
      const visibleNote = store.addBlock("myoxus:note", {}, rootId);
      const h1 = store.addBlock(
        "myoxus:paragraph",
        { type: "h1", text: new Text("Overview") },
        visibleNote,
      );
      const callout = store.addBlock("myoxus:callout", {}, visibleNote);
      const nestedH2 = store.addBlock(
        "myoxus:paragraph",
        { type: "h2", text: new Text("Overview") },
        callout,
      );
      const list = store.addBlock(
        "myoxus:list",
        { type: "bulleted", text: new Text("Item") },
        visibleNote,
      );
      const nestedH3 = store.addBlock(
        "myoxus:paragraph",
        { type: "h3", text: new Text("Deep Detail") },
        list,
      );
      const emptyH2 = store.addBlock(
        "myoxus:paragraph",
        { type: "h2", text: new Text("") },
        visibleNote,
      );
      void emptyH2;
      store.addBlock("myoxus:table-of-contents", {}, visibleNote);

      const footnote = store.addBlock(
        "myoxus:footnote-definition",
        { label: "1" },
        visibleNote,
      );
      const footnoteHeading = store.addBlock(
        "myoxus:paragraph",
        { type: "h2", text: new Text("Footnote Heading") },
        footnote,
      );
      const edgelessNote = store.addBlock(
        "myoxus:note",
        { displayMode: NoteDisplayMode.EdgelessOnly },
        rootId,
      );
      const edgelessHeading = store.addBlock(
        "myoxus:paragraph",
        { type: "h1", text: new Text("Canvas Only") },
        edgelessNote,
      );

      const all = getReadablePageHeadingBlocksFromStore(store, {
        minLevel: 1,
        maxLevel: 3,
      });
      expect(all.map((b) => b.id)).toEqual([h1, nestedH2, nestedH3]);
      expect(all.some((b) => b.id === footnoteHeading)).toBe(false);
      expect(all.some((b) => b.id === edgelessHeading)).toBe(false);

      const narrowed = getReadablePageHeadingBlocksFromStore(store, {
        minLevel: 2,
        maxLevel: 2,
      });
      expect(narrowed.map((b) => b.id)).toEqual([nestedH2]);
    } finally {
      workspace.dispose();
    }
  });
});
