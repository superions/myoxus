// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AnnotationBlockModel,
  AnnotationSchema,
  expandAnnotationSelection,
  getAnnotationRanges,
} from "@virgultum/editor/model/annotation";
import { Container } from "@virgultum/global/di";
import {
  ClipboardAdapter,
  HtmlAdapter,
  MarkdownAdapter,
  MixTextAdapter,
  pasteMiddleware,
} from "@virgultum/shared/adapters";
import { printToPdf } from "@virgultum/shared/utils";
import {
  Text,
  Slice,
  toDraftModel,
  SliceSnapshotSchema,
  type SliceSnapshot,
  type BlockSnapshot,
} from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { describe, expect, test, vi } from "vitest";
import { html } from "lit";
import {
  AnnotationBlockComponent,
  annotationSlashMenuConfig,
  type AnnotationBlockHostProps,
  type AnnotationInlineHostProps,
} from "@virgultum/editor/blocks/annotation";
import {
  BlockSelection,
  TextSelection,
  type BlockStdScope,
} from "@virgultum/std";

import {
  AnnotationInlineSpecExtension,
  InlineAnnotation,
  InlineDocumentField,
} from "@virgultum/editor/inlines/preset";
import type { DocumentFieldInlineHostProps } from "@virgultum/shared/services";
import { InlineEditor } from "@virgultum/std/inline";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { createJob } from "./utils/create-job";
import { getProvider } from "./utils/get-provider";
import { testStoreExtensions } from "./utils/store";
import syntaxFixtures from "../../../../../build/fixtures/contracts/annotation-syntax.json";
import interchangeFixtures from "../../../../../build/fixtures/contracts/annotation-interchange.json";
import { annotationsToLiteralSnapshot } from "../../../shared/src/adapters/markdown/annotation-deltas";
import { builtinToolbarConfig } from "../../../blocks/root/src/configs/toolbar";
import { TableCell } from "../../../blocks/table/src/table-cell";
import { TableDataManager } from "../../../blocks/table/src/table-data-manager";
import { SelectionController } from "../../../blocks/table/src/selection-controller";
import { PageKeyboardManager } from "../../../blocks/root/src/keyboard/keyboard-manager";
import { EdgelessCRUDExtension } from "../../../blocks/surface/src/extensions/crud-extension";
import type { GfxModel } from "@virgultum/std/gfx";
import { convertSelectedBlocksToLinkedDoc } from "@virgultum/block-embed";
import type { TableBlockModel } from "@virgultum/model";
import { mergeToCodeModel, transformModel } from "@virgultum/shared/utils";

test("fixed native cells reject destructive table operations before changing free cells", () => {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = testStoreExtensions;
  workspace.meta.initialize();
  const doc = workspace.createDoc("fixed-table");
  doc.load();
  const store = doc.getStore();
  try {
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const id = store.addBlock(
      "myoxus:table",
      {
        rows: {
          a: { rowId: "a", order: "00000000" },
          b: { rowId: "b", order: "00000001" },
        },
        columns: { c: { columnId: "c", order: "00000000" } },
        cells: {
          "a:c": { text: new Text("Definition"), textProtection: "fixed" },
          "b:c": { text: new Text("Free answer") },
        },
      },
      note,
    );
    const table = store.getModelById(id)! as TableBlockModel;
    const manager = new TableDataManager(table);
    const selectionController = new SelectionController({
      dataManager: manager,
      addController: () => {},
    } as never);
    selectionController.doPaste("Replaced", {
      type: "area",
      rowStartIndex: 0,
      rowEndIndex: 1,
      columnStartIndex: 0,
      columnEndIndex: 0,
    });
    manager.clearCells([
      { rowId: "b", columnId: "c" },
      { rowId: "a", columnId: "c" },
    ]);
    manager.deleteRow("a");
    manager.deleteColumn("c");
    manager.addNRow(-2);
    store.deleteBlock(store.getModelById(note)!);
    expect(manager.rows$.value.map((row) => row.rowId)).toEqual(["a", "b"]);
    expect(manager.getCell("a", "c")?.text.toString()).toBe("Definition");
    expect(manager.getCell("b", "c")?.text.toString()).toBe("Free answer");
    const inserted = manager.addRow(0);
    expect(manager.rows$.value.map((row) => row.rowId)).toEqual([
      "a",
      inserted,
      "b",
    ]);
    expect(manager.getCell("a", "c")?.textProtection).toBe("fixed");
    manager.getCell("b", "c")!.text.insert(" edited", 11);
    expect(manager.getCell("b", "c")?.text.toString()).toBe(
      "Free answer edited",
    );
    store.readonly = true;
    manager.clearRow("b");
    manager.deleteRow("b");
    expect(manager.getCell("b", "c")?.text.toString()).toBe(
      "Free answer edited",
    );
    store.readonly = false;
    manager.clearRow("b");
    expect(manager.getCell("b", "c")?.text.toString()).toBe("");
  } finally {
    workspace.dispose();
  }
});

test("native history skips fixed insertion without hiding older free edits", () => {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = testStoreExtensions;
  workspace.meta.initialize();
  const doc = workspace.createDoc("fixed-history");
  doc.load();
  const store = doc.getStore();
  try {
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const text = new Text("Free");
    store.addBlock("myoxus:paragraph", { text }, note);
    store.resetHistory();
    text.insert(" first", text.length);
    store.captureSync();
    const fixed = store.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("Definition"),
        textProtection: "fixed",
      },
      note,
    );
    store.captureSync();
    text.insert(" second", text.length);
    store.captureSync();
    // Rich-text keyboard handlers use this same supplied manager directly.
    store.history.undoManager.undo();
    expect(text.toString()).toBe("Free first");
    store.undo();
    expect(text.toString()).toBe("Free");
    expect(store.getModelById(fixed)?.text?.toString()).toBe("Definition");
    store.redo();
    store.history.undoManager.redo();
    expect(text.toString()).toBe("Free first second");
    expect(store.getModelById(fixed)?.text?.toString()).toBe("Definition");
  } finally {
    workspace.dispose();
  }
});

test("compound page and canvas deletion reject fixed selections before deleting free neighbors", () => {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = testStoreExtensions;
  workspace.meta.initialize();
  const doc = workspace.createDoc("fixed-keyboard");
  doc.load();
  const store = doc.getStore();
  try {
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const free = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Free neighbor") },
      note,
    );
    const fixed = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Definition"), textProtection: "fixed" },
      note,
    );
    const selection = {
      value: [
        new BlockSelection({ blockId: free }),
        new BlockSelection({ blockId: fixed }),
      ],
      clear: vi.fn(),
    };
    let remove!: (ctx: never) => void;
    new PageKeyboardManager({
      store,
      host: { selection },
      bindHotKey: (bindings: { Backspace: typeof remove }) => {
        remove = bindings.Backspace;
      },
    } as never);
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      cancelable: true,
    });
    remove({ get: () => ({ event }) } as never);
    expect(event.defaultPrevented).toBe(true);
    expect(store.getModelById(free)?.text?.toString()).toBe("Free neighbor");
    expect(store.getModelById(fixed)?.text?.toString()).toBe("Definition");
    expect(selection.clear).not.toHaveBeenCalled();
    const surface = store.addBlock("myoxus:surface", {}, root);
    const freeNote = store.addBlock("myoxus:note", {}, root);
    const canvas = new EdgelessCRUDExtension({
      store,
      get: () => ({ surface: store.getModelById(surface), doc: store }),
    } as unknown as BlockStdScope);
    canvas.deleteElements([
      store.getModelById(freeNote)!,
      store.getModelById(note)!,
    ] as GfxModel[]);
    expect(store.getModelById(freeNote)?.flavour).toBe("myoxus:note");
  } finally {
    workspace.dispose();
  }
});

test("linked-document conversion rejects fixed owners before creating another document", async () => {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = testStoreExtensions;
  workspace.meta.initialize();
  const doc = workspace.createDoc("fixed-linked-conversion");
  doc.load();
  const store = doc.getStore();
  try {
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const free = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Free neighbor") },
      note,
    );
    const fixed = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Definition"), textProtection: "fixed" },
      note,
    );
    using transformer = store.getTransformer();
    const std = {
      clipboard: {
        sliceToSnapshot: (slice: Slice) => transformer.sliceToSnapshot(slice),
        pasteBlockSnapshots: async () => {},
      },
    } as unknown as BlockStdScope;
    const count = workspace.blockCollections.size;
    await expect(
      convertSelectedBlocksToLinkedDoc(
        std,
        store,
        [
          toDraftModel(store.getModelById(free)!),
          toDraftModel(store.getModelById(fixed)!),
        ],
        "Unchanged source",
      ),
    ).resolves.toBeUndefined();
    expect(workspace.blockCollections.size).toBe(count);
    expect(store.getModelById(free)?.text?.toString()).toBe("Free neighbor");
    expect(store.getModelById(fixed)?.text?.toString()).toBe("Definition");
  } finally {
    workspace.dispose();
  }
});

test("document-field and repeat actions respect document and source boundaries", () => {
  const actions = builtinToolbarConfig.actions as unknown as readonly {
    id: string;
    when: (context: never) => boolean;
  }[];
  const available = (id: string, template: boolean, readonly: boolean) => {
    const action = actions.find((item) => item.id === id);
    if (!action) throw new Error(`Missing ${id} action`);
    return action.when({
      readonly,
      std: {
        getOptional: () => ({
          isTemplateDocument: () => template,
          openTemplateVariablePicker: () => {},
        }),
      },
    } as never);
  };
  expect(available("d.template-variable", false, false)).toBe(true);
  expect(available("d.template-repeat", false, false)).toBe(false);
  expect(available("d.template-variable", true, false)).toBe(true);
  expect(available("d.template-repeat", true, false)).toBe(true);
  expect(available("d.template-variable", true, true)).toBe(false);
  expect(available("d.template-repeat", true, true)).toBe(false);
});

function snapshotAnnotations(
  blocks: BlockSnapshot[],
): { body: string; standalone: boolean }[] {
  return blocks.flatMap((block) => {
    const text = block.props.text as
      { delta: Parameters<typeof getAnnotationRanges>[0] } | undefined;
    const cells =
      block.flavour === "myoxus:table"
        ? Object.values(
            block.props.cells as Record<
              string,
              { text: { delta: Parameters<typeof getAnnotationRanges>[0] } }
            >,
          ).flatMap((cell) =>
            getAnnotationRanges(cell.text.delta).map((range) => ({
              body: range.body,
              standalone: false,
            })),
          )
        : [];
    const own =
      block.flavour === "myoxus:annotation"
        ? [
            {
              body: text?.delta.map((delta) => delta.insert).join("") ?? "",
              standalone: true,
            },
          ]
        : getAnnotationRanges(text?.delta ?? []).map((range) => ({
            body: range.body,
            standalone: false,
          }));
    return [...own, ...cells, ...snapshotAnnotations(block.children)];
  });
}

// Exercise the real custom element; the generic Lit setup stubs registration.
vi.unstubAllGlobals();

describe("canonical annotations", () => {
  test.each(interchangeFixtures.filter(({ body }) => body !== "%"))(
    "current native block interchange: $body",
    async ({ body, supported }) => {
      const job = createJob();
      try {
        const adapter = new MarkdownAdapter(job, getProvider());
        const snapshot: BlockSnapshot = {
          type: "block",
          id: "annotation",
          flavour: "myoxus:annotation",
          children: [],
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: body ? [{ insert: body }] : [],
            },
          },
        };
        const result = await adapter.fromBlockSnapshot({ snapshot });
        expect(adapter.exportDiagnostics.unsupportedAnnotations ?? 0).toBe(
          supported ? 0 : 1,
        );
        const readback = await adapter.toBlockSnapshot({ file: result.file });
        expect(snapshotAnnotations(readback.children)).toEqual(
          supported ? [{ body, standalone: true }] : [],
        );
        const text = readback.children[0].props.text as {
          delta: { insert: string }[];
        };
        expect(text.delta.map((delta) => delta.insert).join("")).toBe(
          supported ? body : `%%${body}%%`,
        );
        expect(snapshot.props.text).toEqual({
          "$virgultum:internal:text$": true,
          delta: body ? [{ insert: body }] : [],
        });
      } finally {
        job[Symbol.dispose]();
      }
    },
  );
  test("registered doc/block/slice writers retain logical bodies, neighboring IDs, code and report sole-inline normalization", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const paragraph: BlockSnapshot = {
        type: "block",
        id: "paragraph",
        flavour: "myoxus:paragraph",
        children: [],
        props: {
          type: "text",
          text: {
            "$virgultum:internal:text$": true,
            delta: [
              { insert: "Before ", attributes: { bold: true } },
              { insert: "first\n", attributes: { annotation: { id: "a" } } },
              {
                insert: "second %% ✓",
                attributes: { annotation: { id: "a" }, bold: true },
              },
              { insert: "neighbor", attributes: { annotation: { id: "b" } } },
              { insert: " after " },
              { insert: "%%code%%", attributes: { code: true } },
            ],
          },
        },
      };
      const first = await adapter.fromBlockSnapshot({ snapshot: paragraph });
      expect(adapter.exportDiagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
        unsupportedAnnotations: 1,
      });
      const readback = await adapter.toBlockSnapshot({ file: first.file });
      expect(snapshotAnnotations(readback.children)).toEqual([
        { body: "first\nsecond %% ✓", standalone: false },
        { body: "neighbor", standalone: false },
      ]);
      const text = readback.children[0].props.text as {
        delta: { insert: string; attributes?: MyoxusTextAttributes }[];
      };
      expect(text.delta.find((delta) => delta.attributes?.code)?.insert).toBe(
        "%%code%%",
      );
      expect(text.delta.find((delta) => delta.attributes?.bold)?.insert).toBe(
        "Before ",
      );
      const slice = {
        type: "slice" as const,
        workspaceId: "workspace",
        pageId: "doc",
        content: [paragraph],
      };
      expect((await adapter.fromSliceSnapshot({ snapshot: slice })).file).toBe(
        first.file,
      );
      const alone: BlockSnapshot = {
        ...paragraph,
        props: {
          type: "text",
          text: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "alone\nmultiline",
                attributes: { annotation: { id: "c" } },
              },
            ],
          },
        },
      };
      const doc: import("@virgultum/store").DocSnapshot = {
        type: "page",
        meta: { id: "doc", title: "", createDate: 0, tags: [] },
        blocks: {
          type: "block",
          id: "note",
          flavour: "myoxus:note",
          props: {},
          children: [alone],
        },
      };
      const exported = await adapter.fromDocSnapshot({ snapshot: doc });
      expect(adapter.exportDiagnostics.normalizedAnnotations).toBe(1);
      expect(adapter.exportDiagnostics.unsupportedAnnotations ?? 0).toBe(0);
      const reimported = await adapter.toBlockSnapshot({ file: exported.file });
      expect(snapshotAnnotations(reimported.children)).toEqual([
        { body: "alone\nmultiline", standalone: true },
      ]);
    } finally {
      job[Symbol.dispose]();
    }
  });
  test.each(["%%body%%", "ordinary\n\n%%body%%"])(
    "paste lifecycle preserves semantic annotation boundaries in the middle of a paragraph: %s",
    async (source) => {
      const workspace = new TestWorkspace();
      workspace.storeExtensions = testStoreExtensions;
      workspace.meta.initialize();
      const doc = workspace.createDoc("annotation-paste-boundaries");
      doc.load();
      const store = doc.getStore();
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const id = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("beforeafter") },
        note,
      );
      const selection = new TextSelection({
        from: { blockId: id, index: 6, length: 0 },
        to: null,
      });
      const std = {
        store,
        view: { getBlock: (id: string) => ({ model: store.getModelById(id) }) },
        selection: { find: () => selection },
        getOptional: () => undefined,
        host: { updateComplete: Promise.resolve(), querySelector: () => null },
      } as unknown as BlockStdScope;
      const job = createJob([pasteMiddleware(std)]);
      try {
        const adapter = new MixTextAdapter(job, getProvider());
        const slice = await adapter.toSlice({ file: source }, store, note, 1);
        expect(slice).toBeDefined();
        const children = store.getModelById(note)!.children;
        expect(children.map((model) => model.flavour)).toEqual([
          "myoxus:paragraph",
          "myoxus:annotation",
          "myoxus:paragraph",
        ]);
        expect(children.map((model) => model.text!.toString())).toEqual([
          source.startsWith("ordinary") ? "beforeordinary" : "before",
          "body",
          "after",
        ]);
        expect(children[1].children).toEqual([]);
      } finally {
        job[Symbol.dispose]();
        workspace.dispose();
      }
    },
  );
  test("native paste keeps fields and the destination suffix after a trailing table", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("table-paste-suffix");
    doc.load();
    const store = doc.getStore();
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const id = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("beforeafter") },
      note,
    );
    const selection = new TextSelection({
      from: { blockId: id, index: 6, length: 0 },
      to: null,
    });
    const std = {
      store,
      view: { getBlock: (id: string) => ({ model: store.getModelById(id) }) },
      selection: { find: () => selection },
      getOptional: () => undefined,
      host: { updateComplete: Promise.resolve(), querySelector: () => null },
    } as unknown as BlockStdScope;
    const job = createJob([pasteMiddleware(std)]);
    try {
      const markdown = new MixTextAdapter(job, getProvider());
      const snapshot = await markdown.toSliceSnapshot({
        file: "copied\n\n| Heading |\n| --- |\n| Cell |",
        workspaceId: store.workspace.id,
        pageId: store.id,
      });
      expect(snapshot).not.toBeNull();
      const field = {
        type: "input" as const,
        id: "source-field",
        definition: { kind: "text" as const, label: "Answer", required: false },
        value: "saved answer",
      };
      const blocks =
        snapshot!.content[0].flavour === "myoxus:note"
          ? snapshot!.content[0].children
          : snapshot!.content;
      const text = blocks[0].props.text as {
        delta: { insert: string; attributes?: Record<string, unknown> }[];
      };
      text.delta.push({ insert: " ", attributes: { documentField: field } });
      const adapter = new ClipboardAdapter(job, getProvider());
      const slice = await adapter.toSlice(
        { file: JSON.stringify({ snapshot, blobs: {} }) },
        store,
        note,
        1,
      );
      expect(slice).toBeDefined();
      const children = store.getModelById(note)!.children;
      expect(children.map((model) => model.flavour)).toEqual([
        "myoxus:paragraph",
        "myoxus:table",
        "myoxus:paragraph",
      ]);
      expect(children[0].text!.toString()).toBe("beforecopied ");
      const copiedField = children[0]
        .text!.toDelta()
        .find((run) => run.attributes?.documentField)
        ?.attributes?.documentField;
      expect(copiedField).toMatchObject({ value: "saved answer" });
      expect(copiedField?.id).not.toBe(field.id);
      expect(children[2].text!.toString()).toBe("after");
    } finally {
      job[Symbol.dispose]();
      workspace.dispose();
    }
  });
  test("table-cell native field clipboard preserves identities and fences stale writes", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("field-cell-copy");
    doc.load();
    const store = doc.getStore();
    const root = store.addBlock("myoxus:page");
    const note = store.addBlock("myoxus:note", {}, root);
    const field = {
      type: "input" as const,
      id: "cell-answer",
      definition: { kind: "text" as const, label: "Answer", required: false },
      value: "  literal {{answer}}  ",
    };
    const text = new Text<MyoxusTextAttributes>([
      { insert: "before" },
      { insert: " ", attributes: { documentField: field } },
      { insert: "after" },
    ]);
    store.addBlock("myoxus:paragraph", { text }, note);
    if (!customElements.get("myoxus-test-table-cell"))
      customElements.define("myoxus-test-table-cell", TableCell);
    const cell = document.createElement("myoxus-test-table-cell") as TableCell;
    const range = { index: 6, length: 1 };
    const editor = {
      getInlineRange: vi.fn(() => range),
      deleteText: vi.fn(),
      setInlineRange: vi.fn(),
      syncInlineRange: vi.fn(),
      yText: text.yText,
      isReadonly: false,
      embedDeltas: text.toDelta(),
      isEmbed: () => false,
      transact: (callback: () => void) => store.transact(callback),
    };
    cell.text = text;
    cell.dataManager = { readonly$: { value: false } } as never;
    cell.richText$.value = { inlineEditor: editor } as never;
    const copySnapshot = vi.fn(async (_snapshot: SliceSnapshot) => {});
    let copied!: SliceSnapshot;
    let imported!: SliceSnapshot;
    const prepared = {
      get snapshot() {
        return imported;
      },
      assertCurrent: vi.fn(),
      dispose: vi.fn(),
    };
    const readFromClipboard = vi.fn(() => ({
      "VIRGULTUM/SNAPSHOT": JSON.stringify({ snapshot: copied, blobs: {} }),
    }));
    const prepareNativeSlice = vi.fn(async () => prepared);
    const std = {
      clipboard: { copySnapshot, readFromClipboard, prepareNativeSlice },
      getOptional: () => undefined,
    };
    const table = { store, std, host: { std } };
    vi.spyOn(cell, "closest").mockReturnValue(table as never);
    vi.spyOn(cell, "isConnected", "get").mockReturnValue(true);
    const invoke = (type: "copy" | "cut") => {
      const event = {
        type,
        clipboardData: {},
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      (
        cell as unknown as { copyNativeFields: (event: unknown) => void }
      ).copyNativeFields(event);
      return event;
    };
    try {
      const copy = invoke("copy");
      expect(copy.preventDefault).toHaveBeenCalledOnce();
      expect(copySnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [
            expect.objectContaining({
              flavour: "myoxus:paragraph",
              props: expect.objectContaining({
                text: expect.objectContaining({
                  delta: [
                    { insert: " ", attributes: { documentField: field } },
                  ],
                }),
              }),
            }),
          ],
        }),
      );
      copied = SliceSnapshotSchema.parse(copySnapshot.mock.calls[0][0]);
      const job = createJob();
      try {
        const adapter = new ClipboardAdapter(job, getProvider());
        imported = await adapter.toSliceSnapshot({
          file: JSON.stringify({ snapshot: copied, blobs: {} }),
          assets: job.assetsManager,
        });
        const importedDelta = imported.content[0].props.text as {
          delta: { attributes?: { documentField?: typeof field } }[];
        };
        expect(importedDelta.delta[0].attributes?.documentField).toMatchObject({
          value: field.value,
        });
        expect(importedDelta.delta[0].attributes?.documentField?.id).not.toBe(
          field.id,
        );
      } finally {
        job[Symbol.dispose]();
      }
      invoke("cut");
      await vi.waitFor(() =>
        expect(editor.deleteText).toHaveBeenCalledWith(range),
      );
      editor.deleteText.mockClear();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      invoke("cut");
      editor.getInlineRange.mockReturnValue({ index: 0, length: 1 });
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(editor.deleteText).not.toHaveBeenCalled();
      editor.getInlineRange.mockReturnValue({ index: 0, length: 0 });
      const before = text.toDelta();
      let release!: () => void;
      prepareNativeSlice.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(prepared);
          }),
      );
      const stalePaste = {
        clipboardData: {
          getData: () => '<div data-virgultum-snapshot="x"></div>',
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      error.mockClear();
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(stalePaste);
      editor.getInlineRange.mockReturnValue({ index: 1, length: 0 });
      release();
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(text.toDelta()).toEqual(before);
      expect(prepared.dispose).toHaveBeenCalledOnce();
      prepared.dispose.mockClear();
      error.mockRestore();
      editor.getInlineRange.mockReturnValue({ index: 0, length: 0 });
      const paste = {
        clipboardData: {
          getData: () => '<div data-virgultum-snapshot="x"></div>',
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(paste);
      expect(paste.preventDefault).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledOnce());
      expect(prepared.assertCurrent).toHaveBeenCalledOnce();
      const fields = text
        .toDelta()
        .flatMap((run) =>
          run.attributes?.documentField ? [run.attributes.documentField] : [],
        );
      expect(fields).toHaveLength(2);
      expect(fields[0]).toMatchObject({ value: field.value });
      expect(fields[0].id).not.toBe(field.id);
      expect(fields[1]).toEqual(field);
      store.undo();
      expect(text.toDelta()).toEqual(before);
      imported = {
        ...imported,
        content: [...imported.content, structuredClone(imported.content[0])],
      };
      const unsupported = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(paste);
      await vi.waitFor(() => expect(unsupported).toHaveBeenCalled());
      expect(text.toDelta()).toEqual(before);
      unsupported.mockRestore();
      const malformed = structuredClone(copied);
      const malformedText = malformed.content[0].props.text as {
        delta: { attributes: { documentField: { id: string } } }[];
      };
      malformedText.delta[0].attributes.documentField.id = "";
      copied = malformed;
      const invalidError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const invalidPaste = {
        clipboardData: {
          getData: () => '<div data-virgultum-snapshot="x"></div>',
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(invalidPaste);
      expect(invalidPaste.preventDefault).toHaveBeenCalledOnce();
      expect(invalidError).toHaveBeenCalledOnce();
      expect(text.toDelta()).toEqual(before);
      readFromClipboard.mockImplementationOnce(() => {
        throw new Error("Corrupt clipboard envelope");
      });
      const corruptPaste = {
        clipboardData: {
          getData: () => '<div data-virgultum-snapshot="x"></div>',
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(corruptPaste);
      expect(corruptPaste.preventDefault).toHaveBeenCalledOnce();
      expect(text.toDelta()).toEqual(before);
      invalidError.mockRestore();
      const protection = vi
        .spyOn(cell, "textProtection", "get")
        .mockReturnValue("fixed");
      editor.getInlineRange.mockReturnValue(range);
      invoke("cut");
      await vi.waitFor(() =>
        expect(
          copySnapshot.mock.lastCall?.[0].content[0].props.textProtection,
        ).toBe("fixed"),
      );
      expect(editor.deleteText).not.toHaveBeenCalled();
      copied = structuredClone(copySnapshot.mock.lastCall![0]);
      imported = structuredClone(copied);
      protection.mockRestore();
      const destination: {
        text: typeof text;
        textProtection?: "source" | "fixed";
      } = { text };
      cell.row = { rowId: "r", order: "a0" };
      cell.column = { columnId: "c", order: "a0" };
      cell.dataManager = {
        readonly$: { value: false },
        getCell: () => destination,
      } as never;
      editor.getInlineRange.mockReturnValue({ index: 0, length: 0 });
      const protectedPasteError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(paste);
      await vi.waitFor(() => expect(protectedPasteError).toHaveBeenCalled());
      expect(text.toDelta()).toEqual(before);
      expect(destination.textProtection).toBeUndefined();
      protectedPasteError.mockRestore();
      prepared.dispose.mockClear();
      editor.getInlineRange.mockReturnValue({ index: 0, length: text.length });
      (
        cell as unknown as { pasteNativeFields: (event: unknown) => void }
      ).pasteNativeFields(paste);
      await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledOnce());
      expect(destination.textProtection).toBe("fixed");
    } finally {
      workspace.dispose();
    }
  });
  test("code, indented code and Mermaid retain their literal source through registered import/export", async () => {
    const job = createJob();
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const snapshot = await adapter.toSliceSnapshot({
        file: "```text\n%%fence literal%%\n```\n\n    %%indent literal%%\n\n```mermaid\ngraph TD\nA-->B\n%%mermaid literal%%\n```",
        workspaceId: "source",
        pageId: "doc",
      });
      const blocks = snapshot!.content[0].children;
      expect(blocks.map((block) => block.flavour)).toEqual([
        "myoxus:code",
        "myoxus:code",
        "myoxus:mermaid",
      ]);
      const value = (text: unknown) =>
        (text as { delta: { insert: string }[] }).delta
          .map((delta) => delta.insert)
          .join("");
      expect(value(blocks[0].props.text)).toBe("%%fence literal%%");
      expect(value(blocks[1].props.text)).toBe("%%indent literal%%");
      expect(value(blocks[2].props.source)).toContain("%%mermaid literal%%");
      expect(snapshotAnnotations(snapshot!.content)).toEqual([]);
      const exported = await adapter.fromSliceSnapshot({ snapshot: snapshot! });
      expect(exported.file).toContain("%%fence literal%%");
      expect(exported.file).toContain("%%indent literal%%");
      expect(exported.file).toContain("%%mermaid literal%%");
    } finally {
      job[Symbol.dispose]();
    }
  });
  test.each([false, true])(
    "code paste keeps one literal span across deltas and standalone blocks (inline=%s)",
    (inlineCode) => {
      const paragraph: BlockSnapshot = {
        type: "block",
        id: "p",
        flavour: "myoxus:paragraph",
        children: [],
        props: {
          type: "text",
          text: {
            "$virgultum:internal:text$": true,
            delta: [
              { insert: "Before " },
              {
                insert: "first\n",
                attributes: { annotation: { id: "a" }, bold: true },
              },
              { insert: "second", attributes: { annotation: { id: "a" } } },
              { insert: " after %%%%" },
            ],
          },
        },
      };
      const block: BlockSnapshot = {
        type: "block",
        id: "a",
        flavour: "myoxus:annotation",
        children: [],
        props: {
          text: {
            "$virgultum:internal:text$": true,
            delta: [{ insert: "block body" }],
          },
        },
      };
      annotationsToLiteralSnapshot(paragraph, inlineCode);
      annotationsToLiteralSnapshot(block, inlineCode);
      const attrs = inlineCode ? { attributes: { code: true } } : {};
      expect(paragraph.props.text).toEqual({
        "$virgultum:internal:text$": true,
        delta: [{ insert: "Before %%first\nsecond%% after %%%%", ...attrs }],
      });
      expect(block.flavour).toBe("myoxus:paragraph");
      expect(block.props.text).toEqual({
        "$virgultum:internal:text$": true,
        delta: [{ insert: "%%block body%%", ...attrs }],
      });
    },
  );
  test.each(
    syntaxFixtures.filter(({ name }) =>
      [
        "literal HTML body",
        "HTML code literal",
        "literal preprocessing syntax",
        "quoted multiline inline",
        "listed multiline inline",
        "blank line inline",
        "padded block",
        "standalone list annotation",
        "standalone quote annotation",
        "empty inline literal",
        "soft wrap is not block",
        "unmatched literal",
        "escaped literal pairs",
        "escaped body delimiter",
        "tilde fence literal",
        "do not cross inline code",
        "do not cross fenced code",
        "do not cross indented code",
        "list and table cells",
      ].includes(name),
    ),
  )(
    "registered Markdown and plain clipboard codecs: $name",
    async (fixture) => {
      const job = createJob();
      try {
        for (const Adapter of [MarkdownAdapter, MixTextAdapter]) {
          const adapter = new Adapter(job, getProvider());
          const snapshot = await adapter.toSliceSnapshot({
            file: fixture.markdown,
            workspaceId: "source",
            pageId: "doc",
          });
          expect(snapshotAnnotations(snapshot?.content ?? [])).toEqual(
            fixture.annotations,
          );
        }
      } finally {
        job[Symbol.dispose]();
      }
    },
  );
  test("HTML clipboard retains surrounding structure and converts only eligible literal runs", async () => {
    const job = createJob();
    try {
      const adapter = new HtmlAdapter(job, getProvider());
      const snapshot = await adapter.toSliceSnapshot({
        file: "<p><strong>Before </strong>%%literal **body** [[Notiz]]<br>second line%% after <code>%%code%%</code></p><p>%%Check the publication scope.<br><br>Keep the private approval details here.%%</p><pre>%%fence%%</pre>",
        workspaceId: "source",
        pageId: "doc",
      });
      expect(snapshotAnnotations(snapshot?.content ?? [])).toEqual([
        { body: "literal **body** [[Notiz]]\nsecond line", standalone: false },
        {
          body: "Check the publication scope.\n\nKeep the private approval details here.",
          standalone: true,
        },
      ]);
      const paragraph = snapshot!.content[0].children[0];
      const text = paragraph.props.text as {
        delta: { insert: string; attributes?: Record<string, unknown> }[];
      };
      expect(text.delta[0]).toEqual({
        insert: "Before ",
        attributes: { bold: true },
      });
      expect(
        text.delta.find((delta) => delta.insert.includes("%%code%%"))
          ?.attributes?.code,
      ).toBe(true);
      const plain = new MixTextAdapter(job, getProvider());
      const output = await plain.fromSliceSnapshot({ snapshot: snapshot! });
      expect(output.file).toContain(
        "%%literal **body** [[Notiz]]\nsecond line%%",
      );
      expect(output.file).toContain(
        "%%Check the publication scope.\n\nKeep the private approval details here.%%",
      );
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("browser printing removes annotation projections from its clone, never from the live source", async () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>Before <myoxus-inline-annotation>hidden inline</myoxus-inline-annotation> after</p><myoxus-annotation>hidden block</myoxus-annotation>";
    const clones: { text: string | null; annotations: number }[] = [];
    await printToPdf(root, {
      beforeprint: (iframe) => {
        const target = iframe.contentWindow!;
        clones.push({
          text: target.document.body.textContent,
          annotations: target.document.querySelectorAll(
            "myoxus-annotation, myoxus-inline-annotation",
          ).length,
        });
        target.print = () => target.dispatchEvent(new Event("afterprint"));
      },
    });
    expect(clones.length).toBeGreaterThan(0);
    for (const clone of clones) {
      expect(clone.text).toContain("Before  after");
      expect(clone.text).not.toContain("hidden");
      expect(clone.annotations).toBe(0);
    }
    expect(root.textContent).toContain("hidden inline");
    expect(root.textContent).toContain("hidden block");
    expect(
      root.querySelectorAll("myoxus-annotation, myoxus-inline-annotation"),
    ).toHaveLength(2);
    expect(document.querySelector("iframe")).toBeNull();
  });
  test("HTML reading and clipboard projections hide block and multiline inline bodies without mutating snapshots", async () => {
    const job = createJob();
    const adapter = new HtmlAdapter(job, getProvider());
    const snapshot: SliceSnapshot = {
      type: "slice",
      workspaceId: "source",
      pageId: "doc",
      content: [
        {
          type: "block",
          id: "paragraph",
          flavour: "myoxus:paragraph",
          children: [],
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                { insert: "Before " },
                {
                  insert: "hidden first\n",
                  attributes: { annotation: { id: "a" }, bold: true },
                },
                {
                  insert: "hidden second",
                  attributes: {
                    annotation: { id: "a" },
                    link: "https://example.org",
                  },
                },
                { insert: "after", attributes: { bold: true } },
                {
                  insert: " malformed stays",
                  attributes: { annotation: { id: "" } },
                },
              ],
            },
          },
        },
        {
          type: "block",
          id: "annotation",
          flavour: "myoxus:annotation",
          children: [],
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "hidden block" }],
            },
          },
        },
      ],
    };
    const original = structuredClone(snapshot);
    try {
      const slice = await adapter.fromSliceSnapshot({ snapshot });
      expect(slice.file).toContain("Before ");
      expect(slice.file).toContain("<strong>after</strong>");
      expect(slice.file).toContain("malformed stays");
      expect(slice.file).not.toContain("hidden");
      const block = await adapter.fromBlockSnapshot({
        snapshot: {
          type: "block",
          id: "note",
          flavour: "myoxus:note",
          props: {},
          children: snapshot.content,
        },
      });
      expect(block.file).toContain("Before ");
      expect(block.file).not.toContain("hidden");
      expect(snapshot).toEqual(original);
    } finally {
      job[Symbol.dispose]();
    }
  });
  test("inline host updates one canonical multiline body, rejects stale or detached targets, and removes empty bodies", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-inline-host");
    doc.load();
    const store = doc.getStore();
    const owner = document.createElement("div");
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const text = new Text("before  after");
      const id = store.addBlock("myoxus:paragraph", { text }, note);
      text.insert("original\n✓", 7, { annotation: { id: "a" } });
      owner.dataset.blockId = id;
      document.body.append(owner);
      if (!customElements.get("myoxus-inline-annotation"))
        customElements.define("myoxus-inline-annotation", InlineAnnotation);
      const component = document.createElement("myoxus-inline-annotation");
      component.editor = new InlineEditor<MyoxusTextAttributes>(text.yText);
      component.startOffset = 7;
      component.delta = {
        insert: "original\n✓",
        attributes: { annotation: { id: "a" } },
      };
      let props!: AnnotationInlineHostProps;
      component.std = {
        store,
        getOptional: () => ({
          showAnnotations: true,
          renderInline: (value: AnnotationInlineHostProps) => {
            props = value;
            return html``;
          },
        }),
      } as unknown as BlockStdScope;
      owner.append(component);
      await component.updateComplete;
      expect(props.body).toBe("original\n✓");
      expect(props.apply("changed\n🙂", props.body)).toBe(true);
      expect(text.toString()).toBe("before changed\n🙂 after");
      expect(props.apply("stale", "original\n✓")).toBe(false);
      store.undo();
      expect(text.toString()).toBe("before original\n✓ after");
      store.redo();
      expect(text.toString()).toBe("before changed\n🙂 after");
      store.readonly = true;
      expect(props.remove("changed\n🙂")).toBe(false);
      store.readonly = false;
      expect(props.apply("", "changed\n🙂")).toBe(true);
      expect(text.toString()).toBe("before  after");
      expect(getAnnotationRanges(text.toDelta())).toHaveLength(0);
      store.undo();
      expect(text.toString()).toBe("before changed\n🙂 after");
      store.deleteBlock(store.getModelById(id)!);
      expect(props.apply("resurrect", "changed\n🙂")).toBe(false);
      expect(props.remove("changed\n🙂")).toBe(false);
    } finally {
      owner.remove();
      workspace.dispose();
    }
  });
  test("inline field conversion preserves marks, adjacent atoms and native undo", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("field-inline-host");
    doc.load();
    const store = doc.getStore();
    const owner = document.createElement("div");
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const field = {
        type: "input" as const,
        id: "answer",
        definition: { kind: "text" as const, label: "Answer", required: false },
        value: "A {{literal}}",
      };
      const adjacent = {
        type: "input" as const,
        id: "adjacent",
        definition: {
          kind: "multi-select" as const,
          label: "Choices",
          required: false,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        value: ["a", "b"],
      };
      const text = new Text<MyoxusTextAttributes>([
        { insert: "Before " },
        { insert: " ", attributes: { documentField: field, bold: true } },
        { insert: " ", attributes: { documentField: adjacent, italic: true } },
        { insert: " after" },
      ]);
      const id = store.addBlock("myoxus:paragraph", { text }, note);
      owner.dataset.blockId = id;
      document.body.append(owner);
      if (!customElements.get("myoxus-inline-document-field"))
        customElements.define(
          "myoxus-inline-document-field",
          InlineDocumentField,
        );
      const component = document.createElement("myoxus-inline-document-field");
      component.editor = new InlineEditor<MyoxusTextAttributes>(text.yText);
      component.startOffset = 7;
      component.delta = {
        insert: " ",
        attributes: { documentField: field, bold: true },
      };
      let props!: DocumentFieldInlineHostProps;
      let isTemplate = true;
      component.std = {
        store,
        getOptional: () => ({
          isTemplateDocument: () => isTemplate,
          renderInline: (value: DocumentFieldInlineHostProps) => {
            props = value;
            return html``;
          },
        }),
      } as unknown as BlockStdScope;
      owner.append(component);
      await component.updateComplete;
      const edited = {
        ...field,
        definition: { ...field.definition, label: "Edited" },
      };
      expect(props.updateDefinition({ ...field, value: "stale" }, edited)).toBe(
        false,
      );
      expect(
        props.updateDefinition(field, { ...edited, value: "changed answer" }),
      ).toBe(false);
      isTemplate = false;
      expect(props.updateDefinition(field, edited)).toBe(false);
      isTemplate = true;
      expect(props.updateDefinition(field, edited)).toBe(true);
      expect(text.toDelta()).toContainEqual({
        insert: " ",
        attributes: { documentField: edited, bold: true },
      });
      store.undo();
      expect(text.toDelta()).toContainEqual({
        insert: " ",
        attributes: { documentField: field, bold: true },
      });
      component.startOffset = 8;
      component.delta = {
        insert: " ",
        attributes: { documentField: adjacent, italic: true },
      };
      await component.updateComplete;
      const reordered = {
        ...adjacent,
        definition: {
          ...adjacent.definition,
          options: [...adjacent.definition.options].reverse(),
        },
        value: ["b", "a"],
      };
      expect(
        props.updateDefinition(adjacent, { ...reordered, value: ["a"] }),
      ).toBe(false);
      expect(props.updateDefinition(adjacent, reordered)).toBe(true);
      expect(text.toDelta()).toContainEqual({
        insert: " ",
        attributes: { documentField: reordered, italic: true },
      });
      store.undo();
      component.startOffset = 7;
      component.delta = {
        insert: " ",
        attributes: { documentField: field, bold: true },
      };
      await component.updateComplete;
      isTemplate = false;
      const answered = { ...field, value: "  Literal {{answer}}  " };
      expect(props.updateValue({ ...field, value: "stale" }, answered)).toBe(
        false,
      );
      expect(props.updateValue(field, answered)).toBe(true);
      expect(text.toDelta()).toContainEqual({
        insert: " ",
        attributes: { documentField: answered, bold: true },
      });
      store.undo();
      expect(text.toDelta()).toContainEqual({
        insert: " ",
        attributes: { documentField: field, bold: true },
      });
      expect(props.convertToText({ ...field, value: "stale" }, "wrong")).toBe(
        false,
      );
      const fieldOwner = store.getModelById(id)!;
      fieldOwner.yBlock.set("prop:textProtection", "fixed");
      isTemplate = true;
      const protectedDelta = text.toDelta();
      text.insert("forbidden", 0);
      text.delete(0, text.length);
      text.format(0, text.length, { italic: true });
      expect(() => text.split(3)).toThrow("Cannot split fixed text");
      store.updateBlock(fieldOwner, { text: new Text("forbidden") });
      store.deleteBlock(store.getModelById(note)!);
      expect(text.toDelta()).toEqual(protectedDelta);
      expect(store.getModelById(id)).toBe(fieldOwner);
      expect(store.getParent(fieldOwner)?.id).toBe(note);
      expect(transformModel(fieldOwner, "myoxus:code")).toBeNull();
      const freeId = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("Free sibling") },
        note,
      );
      const freeModel = store.getModelById(freeId)!;
      freeModel.text!.join(text);
      expect(mergeToCodeModel([freeModel, fieldOwner])).toBeNull();
      expect(store.getModelById(freeId)?.text?.toString()).toBe("Free sibling");
      const layoutNote = store.addBlock("myoxus:note", {}, root);
      store.captureSync();
      store.moveBlocks([fieldOwner], store.getModelById(layoutNote)!);
      store.captureSync();
      expect(store.getParent(fieldOwner)?.id).toBe(layoutNote);
      expect(text.toDelta()).toEqual(protectedDelta);
      store.undo();
      expect(store.getParent(fieldOwner)?.id).toBe(note);
      store.redo();
      expect(store.getParent(fieldOwner)?.id).toBe(layoutNote);
      component.editor.setReadonly(true);
      expect(props.updateValue(field, answered)).toBe(true);
      expect(props.convertToText(answered, "forbidden")).toBe(false);
      store.readonly = true;
      expect(props.updateValue(answered, field)).toBe(false);
      store.readonly = false;
      component.editor.setReadonly(false);
      expect(props.convertToText(answered, "forbidden")).toBe(false);
      store.undo();
      expect(
        text
          .toDelta()
          .find((run) => run.attributes?.documentField?.id === field.id)
          ?.attributes?.documentField,
      ).toEqual(field);
      store.redo();
      expect(
        text
          .toDelta()
          .find((run) => run.attributes?.documentField?.id === field.id)
          ?.attributes?.documentField,
      ).toEqual(answered);
      store.undo();
      fieldOwner.yBlock.delete("prop:textProtection");
      isTemplate = false;
      const setRange = vi.spyOn(component.editor, "setInlineRange");
      const capture = vi.spyOn(store, "captureSync");
      expect(props.convertToText(field, "A {{literal}}")).toBe(true);
      expect(setRange).toHaveBeenNthCalledWith(1, { index: 7, length: 0 });
      expect(setRange.mock.invocationCallOrder[0]).toBeLessThan(
        capture.mock.invocationCallOrder[0],
      );
      expect(text.toString()).toBe("Before A {{literal}}  after");
      expect(text.toDelta()).toContainEqual({
        insert: "A {{literal}}",
        attributes: { bold: true },
      });
      expect(
        text.toDelta().find((run) => run.attributes?.documentField)?.attributes
          ?.documentField,
      ).toEqual(adjacent);
      store.undo();
      expect(
        text.toDelta().filter((run) => run.attributes?.documentField),
      ).toHaveLength(2);
      store.redo();
      expect(text.toString()).toBe("Before A {{literal}}  after");
      store.undo();
      store.readonly = true;
      expect(props.convertToText(field, "forbidden")).toBe(false);
      store.readonly = false;
      store.deleteBlock(store.getModelById(id)!);
      expect(props.convertToText(field, "deleted")).toBe(false);
    } finally {
      owner.remove();
      workspace.dispose();
    }
  });
  test("annotate replaces an empty slash leaf at its insertion point and requests body focus", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-slash");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const before = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("before") },
        note,
      );
      const empty = store.addBlock(
        "myoxus:paragraph",
        { text: new Text() },
        note,
      );
      const after = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("after") },
        note,
      );
      const startEditing = vi.fn();
      const std = {
        host: { updateComplete: Promise.resolve() },
        view: {
          getBlock: () => ({ flavour: "myoxus:annotation", startEditing }),
        },
      } as unknown as BlockStdScope;
      const items = annotationSlashMenuConfig.items;
      if (!Array.isArray(items))
        throw new Error("static annotation items expected");
      const item = items[0];
      if (!item || !("action" in item))
        throw new Error("annotation action missing");
      expect(item.searchAlias).toContain("annotate");
      item.action({ std, model: store.getModelById(empty)! });
      await std.host.updateComplete;
      const children = store.getModelById(note)!.children;
      expect(children.map((model) => model.flavour)).toEqual([
        "myoxus:paragraph",
        "myoxus:annotation",
        "myoxus:paragraph",
      ]);
      expect(children[0].id).toBe(before);
      expect(children[2].id).toBe(after);
      expect(store.getModelById(empty)).toBeNull();
      expect(startEditing).toHaveBeenCalledOnce();
      store.undo();
      expect(
        store.getModelById(note)!.children.map((model) => model.id),
      ).toEqual([before, empty, after]);
    } finally {
      workspace.dispose();
    }
  });
  test("block host writes native text atomically and rejects stale, readonly and deleted targets", () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-host");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const id = store.addBlock(
        "myoxus:annotation",
        { text: new Text("original") },
        note,
      );
      if (!customElements.get("myoxus-annotation")) {
        customElements.define("myoxus-annotation", AnnotationBlockComponent);
      }
      const component = document.createElement("myoxus-annotation");
      component.store = store;
      component.dataset.blockId = id;
      let props!: AnnotationBlockHostProps;
      component.std = {
        getOptional: () => ({
          showAnnotations: true,
          renderBlock: (value: AnnotationBlockHostProps) => {
            props = value;
            return html``;
          },
        }),
      } as unknown as BlockStdScope;
      component.renderBlock();
      expect(props.body).toBe("original");
      expect(props.apply("changed\n✓", "original")).toBe(true);
      expect(store.getModelById(id)!.text!.toString()).toBe("changed\n✓");
      store.undo();
      expect(store.getModelById(id)!.text!.toString()).toBe("original");
      store.redo();
      expect(store.getModelById(id)!.text!.toString()).toBe("changed\n✓");
      expect(props.apply("stale", "original")).toBe(false);
      store.readonly = true;
      expect(props.apply("denied", "changed\n✓")).toBe(false);
      store.readonly = false;
      store.deleteBlock(store.getModelById(id)!);
      expect(props.apply("resurrected", "changed\n✓")).toBe(false);
    } finally {
      workspace.dispose();
    }
  });
  test("validates identity without accepting a duplicate body or persisted offsets", () => {
    expect(AnnotationSchema.parse({ id: "annotation-a" })).toEqual({
      id: "annotation-a",
    });
    for (const value of [
      { id: "" },
      { id: "a", body: "copy" },
      { id: "a", index: 1 },
      "a",
    ]) {
      expect(AnnotationSchema.safeParse(value).success).toBe(false);
    }
    const container = new Container();
    AnnotationInlineSpecExtension.setup(container);
    const spec = container
      .provider()
      .get(AnnotationInlineSpecExtension.identifier);
    expect(
      spec.match({ insert: "body", attributes: { annotation: { id: "a" } } }),
    ).toBe(true);
    expect(spec.schema.parse({ annotation: { id: "" } })).toEqual({
      annotation: undefined,
    });
  });

  test("materializes, persists, moves, deletes and restores native text via Store history", async () => {
    const workspace = new TestWorkspace();
    workspace.storeExtensions = testStoreExtensions;
    workspace.meta.initialize();
    const doc = workspace.createDoc("annotation-model");
    doc.load();
    const store = doc.getStore();
    try {
      const root = store.addBlock("myoxus:page");
      const note = store.addBlock("myoxus:note", {}, root);
      const paragraph = store.addBlock(
        "myoxus:paragraph",
        { text: new Text("ordinary") },
        note,
      );
      const id = store.addBlock(
        "myoxus:annotation",
        { text: new Text("body\nsecond line") },
        note,
      );
      const model = store.getModelById(id)!;
      expect(model).toBeInstanceOf(AnnotationBlockModel);
      expect(model.text?.toString()).toBe("body\nsecond line");
      store.captureSync();
      model.text!.insert("changed ", 0);
      store.captureSync();
      store.undo();
      expect(model.text!.toString()).toBe("body\nsecond line");
      store.redo();
      expect(model.text!.toString()).toBe("changed body\nsecond line");

      const text = store.getModelById(paragraph)!.text!;
      text.insert("secret", text.length, { annotation: { id: "inline-a" } });
      text.format(10, 2, { bold: true });
      const ranges = getAnnotationRanges(text.toDelta());
      expect(ranges).toEqual([
        { id: "inline-a", index: 8, length: 6, body: "secret" },
      ]);
      text.insert("before ", 0, {});
      expect(getAnnotationRanges(text.toDelta())).toEqual([
        { ...ranges[0], index: 15 },
      ]);
      const secondNote = store.addBlock("myoxus:note", {}, root);
      store.moveBlocks(
        [store.getModelById(paragraph)!],
        store.getModelById(secondNote)!,
      );
      expect(
        getAnnotationRanges(store.getModelById(paragraph)!.text!.toDelta()),
      ).toEqual([{ ...ranges[0], index: 15 }]);
      const job = createJob();
      const snapshot = job.docToSnapshot(store)!;
      const restored = await job.snapshotToDoc(snapshot);
      expect(restored!.getModelById(id)!.text!.toString()).toBe(
        model.text!.toString(),
      );
      expect(
        getAnnotationRanges(restored!.getModelById(paragraph)!.text!.toDelta()),
      ).toEqual(getAnnotationRanges(text.toDelta()));
      store.captureSync();
      store.deleteBlock(model);
      expect(store.getModelById(id)).toBeNull();
      store.undo();
      expect(store.getModelById(id)!.text!.toString()).toBe(
        "changed body\nsecond line",
      );
      expect(store.getModelById(paragraph)!.text!.toString()).toBe(
        "before ordinarysecret",
      );
      restored!.dispose();
      job[Symbol.dispose]();
    } finally {
      store.dispose();
      workspace.forceStop();
      workspace.dispose();
    }
  });

  test("groups adjacent formatted deltas and newlines without combining different identities", () => {
    expect(
      getAnnotationRanges([
        { insert: "before " },
        { insert: "one\n", attributes: { annotation: { id: "a" } } },
        { insert: "two", attributes: { annotation: { id: "a" }, bold: true } },
        { insert: "three", attributes: { annotation: { id: "b" } } },
        { insert: " ordinary " },
        { insert: "four", attributes: { annotation: { id: "a" } } },
      ]),
    ).toEqual([
      { id: "a", index: 7, length: 7, body: "one\ntwo" },
      { id: "b", index: 14, length: 5, body: "three" },
      { id: "a", index: 29, length: 4, body: "four" },
    ]);
  });

  test("expands a partial marker selection to the entire body, not neighbouring text", () => {
    const deltas = [
      { insert: "before " },
      { insert: "first\n", attributes: { annotation: { id: "a" } } },
      { insert: "second", attributes: { annotation: { id: "a" }, bold: true } },
      { insert: " after" },
    ];
    expect(expandAnnotationSelection(deltas, 9, 1)).toEqual({
      index: 7,
      length: 12,
    });
    expect(expandAnnotationSelection(deltas, 7, 0)).toEqual({
      index: 7,
      length: 0,
    });
    expect(expandAnnotationSelection(deltas, 0, 7)).toEqual({
      index: 0,
      length: 7,
    });
  });

  test("native clipboard remaps the whole fragment while preserving bodies and other attributes", async () => {
    const job = createJob();
    const adapter = new ClipboardAdapter(job, getProvider());
    const snapshot: SliceSnapshot = {
      type: "slice",
      workspaceId: "source",
      pageId: "doc",
      content: [
        {
          type: "block",
          id: "paragraph",
          flavour: "myoxus:paragraph",
          children: [],
          props: {
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                { insert: "first\n", attributes: { annotation: { id: "a" } } },
                {
                  insert: "second",
                  attributes: { annotation: { id: "a" }, bold: true },
                },
                { insert: "other", attributes: { annotation: { id: "b" } } },
              ],
            },
          },
        },
      ],
    };
    try {
      const result = await adapter.toSliceSnapshot({
        file: JSON.stringify({ snapshot, blobs: {} }),
        assets: job.assetsManager,
      });
      const deltas = (
        result.content[0].props.text as {
          delta: {
            insert: string;
            attributes: { annotation: { id: string }; bold?: boolean };
          }[];
        }
      ).delta;
      expect(deltas.map((d) => d.insert)).toEqual([
        "first\n",
        "second",
        "other",
      ]);
      expect(deltas[0].attributes.annotation.id).not.toBe("a");
      expect(deltas[1].attributes.annotation.id).toBe(
        deltas[0].attributes.annotation.id,
      );
      expect(deltas[2].attributes.annotation.id).not.toBe(
        deltas[0].attributes.annotation.id,
      );
      expect(deltas[1].attributes.bold).toBe(true);
      expect(
        (
          snapshot.content[0].props.text as {
            delta: { attributes: { annotation: { id: string } } }[];
          }
        ).delta[0].attributes.annotation.id,
      ).toBe("a");
    } finally {
      job[Symbol.dispose]();
    }
  });
});
