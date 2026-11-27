// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import type { FrameworkProvider } from "@myoxus/infra";
import { SurfaceBlockSchemaExtension } from "@virgultum/editor/blocks/surface";
import {
  BpmnBlockSchemaExtension,
  CalloutBlockSchemaExtension,
  CodeBlockSchemaExtension,
  DividerBlockSchemaExtension,
  FrameBlockSchemaExtension,
  ListBlockSchemaExtension,
  MermaidBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  type CodeBlockModel,
  type ListBlockModel,
  type ParagraphBlockModel,
} from "@virgultum/core/models";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { describe, expect, test } from "vitest";

import { PageInteraction } from "./page-interaction";
import { readPageContent } from "./plain-page-model";

function createHarness(initialParagraphs: string[]) {
  const workspace = new TestWorkspace({ id: "page-interaction-spec" });
  workspace.meta.initialize();
  const doc = workspace.createDoc("doc-1");
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      ListBlockSchemaExtension,
      CodeBlockSchemaExtension,
      CalloutBlockSchemaExtension,
      DividerBlockSchemaExtension,
    ],
  });
  const rootId = store.addBlock("myoxus:page", { title: new Text("Title") });
  const noteId = store.addBlock("myoxus:note", {}, rootId);
  const paraIds = initialParagraphs.map((content) =>
    store.addBlock("myoxus:paragraph", { text: new Text(content) }, noteId),
  );
  store.resetHistory();

  const root = document.createElement("div");
  const body = document.createElement("div");
  body.setAttribute("data-page-body", "");
  body.contentEditable = "true";
  root.append(body);
  document.body.append(root);

  const renderDom = () => {
    body.replaceChildren();
    const content = readPageContent(store)!;
    for (const line of content.lines.slice(1)) {
      const row = document.createElement("div");
      row.className = "plain-page-line";
      const span = document.createElement("span");
      span.dataset.pageText = line.model.id;
      span.dataset.blockId = line.model.id;
      span.textContent = line.text.toString();
      row.append(span);
      body.append(row);
    }
  };
  renderDom();

  const owner = new PageInteraction(
    store,
    root,
    () => readPageContent(store)?.lines ?? [],
    () => true,
    renderDom,
    () => {},
    {} as FrameworkProvider,
  );

  const setCaret = (blockId: string, start: number, end = start) => {
    const span = root.querySelector<HTMLElement>(
      `[data-page-text="${CSS.escape(blockId)}"]`,
    )!;
    const node = span.firstChild ?? span;
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    const r = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) {
      r.setStart(node, start);
      r.setEnd(node, end);
    } else {
      r.setStart(node, 0);
      r.setEnd(node, 0);
    }
    sel.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  };

  const cleanup = () => {
    owner.dispose();
    root.remove();
  };

  return {
    store,
    note: store.getModelById(noteId)!,
    paraIds,
    root,
    body,
    owner,
    setCaret,
    renderDom,
    cleanup,
  };
}

describe("PageInteraction native commands (SPE-06)", () => {
  test("converts Markdown shortcuts on Space directly on Store (#, -, 1., [x], ```)", () => {
    const h = createHarness(["##", "-", "3.", "[x]", "```ts"]);
    try {
      const fireSpace = (blockId: string, offset: number) => {
        h.setCaret(blockId, offset);
        const span = h.root.querySelector<HTMLElement>(
          `[data-page-text="${CSS.escape(blockId)}"]`,
        )!;
        span.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: " ",
          }),
        );
      };

      fireSpace(h.paraIds[0], 2);
      expect(
        (h.store.getModelById(h.paraIds[0]) as ParagraphBlockModel).props.type,
      ).toBe("h2");
      expect(h.store.getModelById(h.paraIds[0])?.text?.toString()).toBe("");

      fireSpace(h.paraIds[1], 1);
      const bullet = h.note.children[1] as ListBlockModel;
      expect(bullet.flavour).toBe("myoxus:list");
      expect(bullet.props.type).toBe("bulleted");

      fireSpace(h.paraIds[2], 2);
      const numbered = h.note.children[2] as ListBlockModel;
      expect(numbered.flavour).toBe("myoxus:list");
      expect(numbered.props.type).toBe("numbered");
      expect(numbered.props.order).toBe(3);

      fireSpace(h.paraIds[3], 3);
      const todo = h.note.children[3] as ListBlockModel;
      expect(todo.flavour).toBe("myoxus:list");
      expect(todo.props.type).toBe("todo");
      expect(todo.props.checked).toBe(true);

      fireSpace(h.paraIds[4], 5);
      const code = h.note.children[4] as CodeBlockModel;
      expect(code.flavour).toBe("myoxus:code");
      expect(code.props.language).toBe("ts");
    } finally {
      h.cleanup();
    }
  });

  test("indents and outdents blocks with Tab / Shift+Tab in single-step transactions", () => {
    const h = createHarness(["Parent", "Child"]);
    try {
      h.setCaret(h.paraIds[1], 0);
      const span = h.root.querySelector<HTMLElement>(
        `[data-page-text="${CSS.escape(h.paraIds[1])}"]`,
      )!;
      span.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(h.store.getParent(h.paraIds[1])?.id).toBe(h.paraIds[0]);

      h.renderDom();
      h.setCaret(h.paraIds[1], 0);
      const nestedSpan = h.root.querySelector<HTMLElement>(
        `[data-page-text="${CSS.escape(h.paraIds[1])}"]`,
      )!;
      nestedSpan.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(h.store.getParent(h.paraIds[1])?.id).toBe(h.note.id);
    } finally {
      h.cleanup();
    }
  });

  test("applies inline link, converts block types, and creates inline linked-doc reference", () => {
    const h = createHarness(["Visit Myoxus docs"]);
    try {
      h.setCaret(h.paraIds[0], 6, 12);
      expect(h.owner.selectedText()).toBe("Myoxus");
      expect(h.owner.applyLink("https://myoxus.example")).toBe(true);
      const linkedDelta = h.store.getModelById(h.paraIds[0])!.text!.toDelta();
      expect(
        linkedDelta.some(
          (op) =>
            op.insert === "Myoxus" &&
            op.attributes?.link === "https://myoxus.example",
        ),
      ).toBe(true);

      expect(h.owner.convertSelectedBlocks("h3")).toBe(true);
      expect(
        (h.store.getModelById(h.paraIds[0]) as ParagraphBlockModel).props.type,
      ).toBe("h3");

      expect(h.owner.convertSelectedBlocks("bulleted")).toBe(true);
      const list = h.note.children[0] as ListBlockModel;
      expect(list.flavour).toBe("myoxus:list");
      expect(list.props.type).toBe("bulleted");

      h.renderDom();
      h.owner.afterRender();
      h.setCaret(list.id, 6, 12);
      expect(h.owner.replaceSelectionWithLinkedDoc("doc-target-42")).toBe(true);
      expect(
        list
          .text!.toDelta()
          .some(
            (op) =>
              op.attributes?.reference &&
              (op.attributes.reference as { pageId?: string }).pageId ===
                "doc-target-42",
          ),
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("projects surface-owned Mermaid diagrams into Page without leaking frames or mutating parent", () => {
    const workspace = new TestWorkspace({ id: "surface-diagram-page-spec" });
    workspace.meta.initialize();
    const doc = workspace.createDoc("surface-doc");
    doc.load();
    const store = doc.getStore({
      extensions: [
        RootBlockSchemaExtension,
        SurfaceBlockSchemaExtension,
        FrameBlockSchemaExtension,
        MermaidBlockSchemaExtension,
        BpmnBlockSchemaExtension,
        NoteBlockSchemaExtension,
        ParagraphBlockSchemaExtension,
      ],
    });
    const rootId = store.addBlock("myoxus:page", {
      title: new Text("Flowchart"),
    });
    const surfaceId = store.addBlock("myoxus:surface", {}, rootId);
    const mermaidId = store.addBlock(
      "myoxus:mermaid",
      { source: "flowchart TD\n  A[Start] --> B[End]" },
      surfaceId,
    );
    store.addBlock("myoxus:frame", {}, surfaceId);

    const surfaceOnlyContent = readPageContent(store);
    expect(surfaceOnlyContent).not.toBeNull();
    expect(
      surfaceOnlyContent!.body.map((item) => [item.kind, item.model.id]),
    ).toEqual([["mermaid", mermaidId]]);
    // Native Store ownership remains directly on myoxus:surface for Edgeless.
    expect(store.getParent(mermaidId)?.flavour).toBe("myoxus:surface");

    // Mixed document: Note content + surface-owned Mermaid project deterministically without duplicates.
    const noteId = store.addBlock("myoxus:note", {}, rootId);
    const paraId = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Notes") },
      noteId,
    );
    const bpmnId = store.addBlock("myoxus:bpmn", {}, noteId);
    const mixedContent = readPageContent(store);
    expect(
      mixedContent!.body.map((item) => [item.kind, item.model.id]),
    ).toEqual([
      ["text", paraId],
      ["bpmn", bpmnId],
      ["mermaid", mermaidId],
    ]);
    expect(store.getParent(mermaidId)?.flavour).toBe("myoxus:surface");
  });
});
