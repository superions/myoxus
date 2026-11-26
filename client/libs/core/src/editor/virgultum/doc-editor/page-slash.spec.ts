// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { I18n } from "@myoxus/i18n";
import {
  CalloutBlockSchemaExtension,
  CodeBlockSchemaExtension,
  DividerBlockSchemaExtension,
  ListBlockSchemaExtension,
  MermaidBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  TableBlockSchemaExtension,
  type ListBlockModel,
  type ParagraphBlockModel,
  type TableBlockModel,
} from "@virgultum/core/models";
import { Text, type BlockModel, type Store } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { describe, expect, test, vi } from "vitest";

import {
  buildPageSlashItems,
  filterPageSlashItems,
  type PageSlashHostCallbacks,
} from "./page-slash-registry";

function createTestStore() {
  const workspace = new TestWorkspace({ id: "page-slash-spec" });
  workspace.meta.initialize();
  const doc = workspace.createDoc("doc-1");
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      ListBlockSchemaExtension,
      MermaidBlockSchemaExtension,
      CodeBlockSchemaExtension,
      DividerBlockSchemaExtension,
      CalloutBlockSchemaExtension,
      TableBlockSchemaExtension,
    ],
  });
  const rootId = store.addBlock("myoxus:page", {});
  const noteId = store.addBlock("myoxus:note", {}, rootId);
  const paraId = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Hello") },
    noteId,
  );
  store.resetHistory();
  return {
    store,
    note: store.getModelById(noteId)!,
    para: store.getModelById(paraId) as ParagraphBlockModel,
  };
}

function createHost(
  store: Store,
  model: BlockModel,
  overrides: Partial<PageSlashHostCallbacks> = {},
): PageSlashHostCallbacks {
  return {
    store,
    model,
    offset: model.text?.length ?? 0,
    canUseServerDatabase: true,
    enableMermaid: true,
    enableAI: true,
    isTemplateDocument: false,
    openLinkPicker: vi.fn(),
    openInlineLink: vi.fn(),
    openEmbedModal: vi.fn(),
    openIframeBlock: vi.fn(),
    openImageUpload: vi.fn(),
    openAttachmentUpload: vi.fn(),
    openEventDialog: vi.fn(),
    openDirectoryModal: vi.fn(),
    openFootnoteMenu: vi.fn(),
    openTemplateVariablePicker: vi.fn(),
    openBuildingBlockPicker: vi.fn(),
    insertNamedBuildingBlock: vi.fn(),
    openTaskCardCreate: vi.fn(),
    openEmbedExistingDatabase: vi.fn(),
    createServerTable: vi.fn(),
    createServerProject: vi.fn(),
    insertMermaidDiagram: vi.fn(),
    insertBpmnDiagram: vi.fn(),
    copyLine: vi.fn(),
    openAiPrompt: vi.fn(),
    ...overrides,
  };
}

describe("PageSlash Store registry (SPE-01)", () => {
  test("contains zero eager @virgultum/editor imports", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const file of ["page-slash-registry.ts", "page-slash.tsx"]) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source).not.toMatch(/from\s+["']@virgultum\/editor/);
      expect(source).not.toMatch(/import\(["']@virgultum\/editor/);
    }
  });

  test("filters and flattens submenus by query", () => {
    const { store, para } = createTestStore();
    const entries = buildPageSlashItems(I18n, createHost(store, para));
    expect(entries.some((e) => e.id === "block-paragraph-h1")).toBe(true);
    expect(entries.some((e) => e.id === "block-table-insert")).toBe(true);
    expect(entries.some((e) => e.id === "ai-ask")).toBe(true);

    const h5 = filterPageSlashItems(entries, "h5", "en");
    expect(h5[0]?.id).toBe("block-paragraph-h5");

    const todo = filterPageSlashItems(entries, "todo", "en");
    expect(todo[0]?.id).toBe("block-list-todo");

    const mermaidElk = filterPageSlashItems(entries, "mermaid elk", "en");
    expect(mermaidElk.some((e) => e.id === "mermaid-flowchart-elk-basic")).toBe(
      true,
    );
    const mermaidElkHyphen = filterPageSlashItems(entries, "mermaid-elk", "en");
    expect(
      mermaidElkHyphen.some((e) => e.id === "mermaid-flowchart-elk-basic"),
    ).toBe(true);
  });

  test("converts paragraph to heading and list with single-step undo", () => {
    const { store, note, para } = createTestStore();
    const entries = buildPageSlashItems(I18n, createHost(store, para));

    const h2 = entries.find((e) => e.id === "block-paragraph-h2")!;
    store.captureSync();
    store.transact(() => h2.runSync!(store, para, 5));
    store.captureSync();
    expect(para.props.type).toBe("h2");

    store.undo();
    expect(para.props.type).toBe("text");

    const todo = entries.find((e) => e.id === "block-list-todo")!;
    store.captureSync();
    let result: { id: string; offset: number } | undefined;
    store.transact(() => {
      result = todo.runSync!(store, para, 5) ?? undefined;
    });
    store.captureSync();
    expect(result).toBeDefined();
    const listModel = store.getModelById(result!.id) as ListBlockModel;
    expect(listModel.flavour).toBe("myoxus:list");
    expect(listModel.props.type).toBe("todo");
    expect(listModel.text?.toString()).toBe("Hello");
    expect(note.children).toHaveLength(1);

    store.undo();
    expect(note.children[0]?.flavour).toBe("myoxus:paragraph");
    expect(note.children[0]?.text?.toString()).toBe("Hello");
  });

  test("inserts callout and 2x2 table directly on Store", () => {
    const { store, note, para } = createTestStore();
    const entries = buildPageSlashItems(I18n, createHost(store, para));

    const callout = entries.find((e) => e.id === "block-callout-insert")!;
    store.captureSync();
    let calloutTarget: { id: string; offset: number } | undefined;
    store.transact(() => {
      calloutTarget = callout.runSync!(store, para, 5) ?? undefined;
    });
    store.captureSync();
    expect(note.children[1]?.flavour).toBe("myoxus:callout");
    expect(calloutTarget?.id).toBe(note.children[1]?.children[0]?.id);

    const table = entries.find((e) => e.id === "block-table-insert")!;
    store.captureSync();
    store.transact(() => table.runSync!(store, para, 5));
    store.captureSync();
    const tableModel = note.children.find(
      (b) => b.flavour === "myoxus:table",
    ) as TableBlockModel | undefined;
    expect(tableModel).toBeDefined();
    expect(Object.keys(tableModel!.props.rows)).toHaveLength(2);
    expect(Object.keys(tableModel!.props.columns)).toHaveLength(2);

    // Inserting a table from inside a Callout walks up to the enclosing Note
    // instead of throwing a schema violation.
    const calloutModel = note.children.find(
      (b) => b.flavour === "myoxus:callout",
    )!;
    const innerParagraph = calloutModel.children[0]!;
    const calloutEntries = buildPageSlashItems(
      I18n,
      createHost(store, innerParagraph),
    );
    const innerTable = calloutEntries.find(
      (e) => e.id === "block-table-insert",
    )!;
    store.captureSync();
    store.transact(() => innerTable.runSync!(store, innerParagraph, 0));
    store.captureSync();
    expect(
      note.children.filter((b) => b.flavour === "myoxus:table"),
    ).toHaveLength(2);
  });
});
