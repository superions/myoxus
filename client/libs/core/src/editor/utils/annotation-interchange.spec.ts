// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { TestWorkspace } from "@virgultum/editor/store/test";
import {
  Slice,
  Text,
  wrapFakeNote,
  type DeltaOperation,
} from "@virgultum/editor/store";
import {
  BlockStdScope,
  decodeClipboardSnapshot,
  ClipboardAdapterConfigExtension,
  BlockSelection,
  TextSelection,
  type EditorHost,
  type BlockComponent,
} from "@virgultum/editor/std";
import { getAnnotationRanges } from "@virgultum/editor/model/annotation";
import {
  MarkdownAdapter,
  ClipboardAdapter,
  HtmlAdapter,
  PlainTextAdapter,
  MixTextAdapter,
  pasteMiddleware,
  docLinkBaseURLMiddleware,
  documentReferenceMiddleware,
  replaceIdMiddleware,
} from "@virgultum/editor/shared/adapters";
import { getStoreManager } from "../manager/store";
import {
  getContentFromSlice,
  markdownToSnapshot,
  markDownToDoc,
  insertFromMarkdown,
  replaceFromMarkdown,
} from "./markdown-utils";
import { __test__ as exportActions } from "../../components/hooks/myoxus/use-export-page";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
import { TemplateJob } from "@virgultum/editor/gfx/template";
import type { SurfaceBlockModel } from "@virgultum/editor/blocks/surface";
import {
  EdgelessClipboardController,
  PageClipboard,
  ReadOnlyClipboard,
} from "@virgultum/editor/blocks/root";
import { clipboardConfigs } from "@virgultum/editor/foundation/clipboard";
import { replace as replaceEditorMarkdown } from "../ai/utils/editor-actions";
import { applyPatchToDoc } from "../ai/utils/apply-model/apply-patch-to-doc";
import JSZip from "jszip";
import type {
  RootBlockModel,
  ParagraphBlockModel,
  TableBlockModel,
  FootnoteDefinitionBlockModel,
  ListBlockModel,
} from "@virgultum/editor/model";
import type { MyoxusTextAttributes } from "@virgultum/editor/shared/types";
import {
  DocEmbedProvider,
  ParseDocUrlExtension,
  NotificationExtension,
} from "@virgultum/editor/shared/services";
import { signal } from "@preact/signals-core";
import mathFixtures from "../../../../../../build/fixtures/contracts/math-interchange.json";
import type { BlockSnapshot } from "@virgultum/editor/store";
import { IntegrationWriter } from "@myoxus/core/modules/integration/entities/writer";
import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { TagService } from "@myoxus/core/modules/tag";
import { Framework, LiveData } from "@myoxus/infra";

afterEach(() => vi.restoreAllMocks());
type SnapshotText = { delta: DeltaOperation[] };

test.each([
  {
    mime: "text/plain",
    source:
      "Immediate **paste** with [external](https://example.org/reference).",
  },
  {
    mime: "text/html",
    source:
      '<p>Immediate <strong>paste</strong> with <a href="https://example.org/reference">external</a>.</p>',
  },
])(
  "native clipboard inserts $mime without requesting unrelated document permissions: $source",
  async ({ mime, source }) => {
    const { workspace, store, note } = fixture();
    for (let index = 0; index < 32; index++)
      workspace.createDoc(`unrelated-paste-${index}`);
    const protectedBlock = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Protected content") },
      note,
    );
    const access: DocEmbedProvider = {
      canRead: vi.fn(async () => {
        throw new Error("Unrelated access must not block paste");
      }),
      referenceTitle: vi.fn(async () => {
        throw new Error("Unrelated titles must not block paste");
      }),
      readable: vi.fn(() => signal(false)),
      waitForLoaded: vi.fn(async () => {
        throw new Error("Unrelated bodies must not block paste");
      }),
    };
    const std = new BlockStdScope({
      store,
      extensions: [
        ...workspace.storeExtensions,
        ...clipboardConfigs,
        { setup: (di) => di.addImpl(DocEmbedProvider, access) },
      ],
    });
    vi.spyOn(std, "host", "get").mockReturnValue({
      updateComplete: Promise.resolve(),
      querySelector: () => null,
    } as unknown as EditorHost);
    std.clipboard.use(pasteMiddleware(std));
    std.clipboard.use(docLinkBaseURLMiddleware(workspace.id));
    std.clipboard.use(documentReferenceMiddleware([]));
    std.clipboard.use(replaceIdMiddleware(workspace.idGenerator));
    const before = store.getModelById(note)!.children.map(({ id }) => id);
    store.captureSync();
    try {
      const inserted = await std.clipboard.paste(
        {
          clipboardData: {
            types: [mime, "text/plain"],
            files: [],
            getData: (type: string) =>
              type === mime ? source : "Wrong fallback",
          },
        } as unknown as ClipboardEvent,
        store,
        note,
        1,
      );
      expect(inserted?.content.length).toBeGreaterThan(0);
      expect(
        store
          .getModelById(note)!
          .children.map(({ text }) => text?.toString())
          .join(" "),
      ).toContain("Immediate");
      expect(store.getModelById(protectedBlock)!.text!.toString()).toBe(
        "Protected content",
      );
      expect(access.canRead).not.toHaveBeenCalled();
      expect(access.referenceTitle).not.toHaveBeenCalled();
      expect(access.readable).not.toHaveBeenCalled();
      expect(access.waitForLoaded).not.toHaveBeenCalled();
      store.captureSync();
      store.undo();
      expect(store.getModelById(note)!.children.map(({ id }) => id)).toEqual(
        before,
      );
      store.redo();
      expect(
        store
          .getModelById(note)!
          .children.map(({ text }) => text?.toString())
          .join(" "),
      ).toContain("Immediate");
    } finally {
      std.unmount();
      workspace.dispose();
    }
  },
);

test("native copy without references checks only its source and still rejects revoked source access", async () => {
  const { workspace, store, note } = fixture();
  for (let index = 0; index < 32; index++)
    workspace.createDoc(`unrelated-copy-${index}`);
  const paragraph = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Immediate copy") },
    note,
  );
  const permission = signal(true);
  const access: DocEmbedProvider = {
    canRead: vi.fn(async (id) => {
      if (id !== store.id)
        throw new Error("Unrelated access must not block copy");
      return permission.value;
    }),
    referenceTitle: vi.fn(async () => {
      throw new Error("Unrelated titles must not block copy");
    }),
    readable: vi.fn(() => permission),
    waitForLoaded: vi.fn(async () => {
      throw new Error("Copy must not reload the source body");
    }),
  };
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      ...clipboardConfigs,
      ReadOnlyClipboard,
      { setup: (di) => di.addImpl(DocEmbedProvider, access) },
    ],
  });
  vi.spyOn(std, "host", "get").mockReturnValue({
    updateComplete: Promise.resolve(),
    querySelector: () => null,
  } as unknown as EditorHost);
  const previousClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  class TestClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  }
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  const write = vi.fn(async (_items: TestClipboardItem[]) => {});
  Reflect.deleteProperty(navigator, "clipboard");
  std.get(ReadOnlyClipboard).mounted();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write },
  });
  const slice = Slice.fromModels(store, [store.getModelById(paragraph)!]);
  store.readonly = true;
  try {
    await std.clipboard.copySlice(slice);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      await write.mock.calls[0][0][0].items["text/plain"].text(),
    ).toContain("Immediate copy");
    expect(
      vi.mocked(access.canRead).mock.calls.every(([id]) => id === store.id),
    ).toBe(true);
    expect(access.referenceTitle).not.toHaveBeenCalled();
    expect(access.waitForLoaded).not.toHaveBeenCalled();
    const readOnly = new LiveData(true);
    const guard = {
      can: vi.fn(async (action: string) => {
        if (action !== "Doc_Read")
          throw new Error("Copy must not require elevated permissions");
        return readOnly.value;
      }),
      can$: vi.fn((action: string) => {
        if (action !== "Doc_Read")
          throw new Error("Copy must observe only read permission");
        return readOnly;
      }),
    };
    const coreAccess = new CoreDocEmbedProvider(
      guard as unknown as GuardService,
      {} as DocsService,
      { id: workspace.id, docCollection: workspace } as never,
    );
    try {
      access.canRead = (id) => coreAccess.canRead(id);
      access.readable = (id) => coreAccess.readable(id);
      await std.clipboard.copySlice(slice);
      expect(write).toHaveBeenCalledTimes(2);
      expect(guard.can).toHaveBeenCalledWith("Doc_Read", store.id);
      // One check protects capture, one protects OS delivery after conversion.
      // Merely observing the grant must not add a third network request.
      expect(guard.can).toHaveBeenCalledTimes(2);
      readOnly.next(false);
      await expect(std.clipboard.copySlice(slice)).rejects.toThrow(
        "source access denied",
      );
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      coreAccess.dispose();
    }
    access.canRead = vi.fn(async () => permission.value);
    access.readable = vi.fn(() => permission);
    write.mockClear();
    permission.value = false;
    await expect(std.clipboard.copySlice(slice)).rejects.toThrow(
      "source access denied",
    );
    expect(write).not.toHaveBeenCalled();
    permission.value = true;
    vi.mocked(access.canRead).mockImplementation(async () => {
      permission.value = false;
      return true;
    });
    await expect(std.clipboard.copySlice(slice)).rejects.toThrow(
      "source access lost",
    );
    expect(write).not.toHaveBeenCalled();
  } finally {
    std.unmount();
    if (previousClipboard)
      Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    vi.unstubAllGlobals();
    workspace.dispose();
  }
});

test.each(["markdown"] as const)(
  "Core %s download without references never requests unrelated document permissions",
  async (format) => {
    const { workspace, store, note } = fixture();
    for (let index = 0; index < 32; index++)
      workspace.createDoc(`unrelated-export-${index}`);
    store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Immediate export") },
      note,
    );
    const sourceOnly = (id: string) => {
      if (id !== store.id)
        throw new Error("Unrelated access must not block export");
      return true;
    };
    const access: DocEmbedProvider = {
      canRead: vi.fn(async (id) => sourceOnly(id)),
      referenceTitle: vi.fn(async (id) => {
        sourceOnly(id);
        return workspace.meta.getDocMeta(id)?.title;
      }),
      readable: vi.fn(() => signal(true)),
      waitForLoaded: vi.fn(async (id) => {
        sourceOnly(id);
      }),
    };
    const files: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      files.push(blob as Blob);
      return "blob:scoped-export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      if (format === "markdown")
        await exportActions.exportToMarkdown(store, undefined, access);
      else await exportActions.exportToHtml(store, undefined, access);
      expect(files).toHaveLength(1);
      expect(await files[0].text()).toContain("Immediate export");
      expect(access.canRead).toHaveBeenCalled();
      expect(
        vi.mocked(access.canRead).mock.calls.every(([id]) => id === store.id),
      ).toBe(true);
      expect(
        vi
          .mocked(access.waitForLoaded)
          .mock.calls.every(([id]) => id === store.id),
      ).toBe(true);
    } finally {
      workspace.dispose();
    }
  },
);

test("Core and native clipboard Markdown guard current targets before writes and preserve missing states", async () => {
  const { workspace, store, note } = fixture();
  const target = workspace.createDoc("opaque-reference-target");
  target.load();
  const targetStore = target.getStore();
  workspace.meta.setDocMeta(target.id, { title: "Old acknowledged title" });
  const root = targetStore.addBlock("myoxus:page", {
    title: new Text("Target"),
  });
  const targetNote = targetStore.addBlock("myoxus:note", {}, root);
  const heading = targetStore.addBlock(
    "myoxus:paragraph",
    { type: "h1", text: new Text("Über Größe") },
    targetNote,
  );
  const paragraph = targetStore.addBlock(
    "myoxus:paragraph",
    { text: new Text("Instruction"), markdownAnchor: "instruction" },
    targetNote,
  );
  const local = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Local decision"), markdownAnchor: "local" },
    note,
  );
  let readable = true;
  let titleAvailable = true;
  const liveReadable = signal(true);
  let revokeAfterPreparation = false;
  class RevokingMixTextAdapter extends MixTextAdapter {
    override async prepareSliceSnapshot(
      ...args: Parameters<MixTextAdapter["prepareSliceSnapshot"]>
    ) {
      const snapshot = await super.prepareSliceSnapshot(...args);
      if (revokeAfterPreparation) liveReadable.value = false;
      return snapshot;
    }
  }
  class RevokingHtmlAdapter extends HtmlAdapter {
    override async prepareSliceSnapshot(
      ...args: Parameters<HtmlAdapter["prepareSliceSnapshot"]>
    ) {
      const snapshot = await super.prepareSliceSnapshot(...args);
      if (revokeAfterPreparation) liveReadable.value = false;
      return snapshot;
    }
  }
  const access: DocEmbedProvider = {
    canRead: vi.fn(
      async (id) => id === store.id || (id === target.id && readable),
    ),
    readable: (id) => (id === target.id ? liveReadable : signal(true)),
    referenceTitle: vi.fn(async (id) =>
      id === target.id
        ? readable && titleAvailable
          ? "Target"
          : undefined
        : workspace.meta.getDocMeta(id)?.title,
    ),
    waitForLoaded: vi.fn(async () => {}),
  };
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      ClipboardAdapterConfigExtension({
        mimeType: ClipboardAdapter.MIME,
        adapter: ClipboardAdapter,
        priority: 100,
      }),
      ClipboardAdapterConfigExtension({
        mimeType: "text/html",
        adapter: RevokingHtmlAdapter,
        priority: 90,
      }),
      ClipboardAdapterConfigExtension({
        mimeType: "text/plain",
        adapter: RevokingMixTextAdapter,
        priority: 70,
      }),
      { setup: (di) => di.addImpl(DocEmbedProvider, access) },
    ],
  });
  const host = { store, std } as EditorHost;
  std.clipboard.use(pasteMiddleware(std));
  std.clipboard.use(docLinkBaseURLMiddleware(workspace.id));
  std.clipboard.use(documentReferenceMiddleware([]));
  std.clipboard.use(replaceIdMiddleware(workspace.idGenerator));
  const source = `[[Target#%C3%9Cber%20Gr%C3%B6%C3%9Fe|heading]] [instruction](${window.location.origin}/workspace/${workspace.id}/${target.id}#%5Einstruction) [[#^local|local]]`;
  const references = (
    snapshot: NonNullable<
      Awaited<ReturnType<typeof markdownToSnapshot>>["snapshot"]
    >,
  ) =>
    snapshot.content[0].children.flatMap((block) =>
      ((block.props.text as SnapshotText)?.delta ?? []).flatMap((delta) =>
        delta.attributes?.reference ? [delta.attributes.reference] : [],
      ),
    );
  try {
    const imported = await markdownToSnapshot(source, store, host);
    expect(imported.diagnostics).toEqual({
      unresolvedReferences: 0,
      unsupportedReferences: 0,
    });
    expect(references(imported.snapshot!)).toEqual([
      {
        type: "LinkedPage",
        pageId: target.id,
        title: "heading",
        params: { mode: "page", blockIds: [heading] },
      },
      {
        type: "LinkedPage",
        pageId: target.id,
        title: "instruction",
        params: { mode: "page", blockIds: [paragraph] },
      },
      {
        type: "LinkedPage",
        pageId: store.id,
        title: "local",
        params: { mode: "page", blockIds: [local] },
      },
    ]);
    imported.transformer[Symbol.dispose]();
    const tableSource = `<table><tbody><tr><td><a href="${window.location.origin}/workspace/${workspace.id}/${target.id}#%5Einstruction">instruction</a></td></tr></tbody></table>`;
    const tableImport = await markdownToSnapshot(tableSource, store, host);
    try {
      const table = tableImport.snapshot!.content[0].children.find(
        ({ flavour }) => flavour === "myoxus:table",
      )!;
      expect(JSON.stringify(table.props.cells)).toContain(
        '"pageId":"' + target.id + '"',
      );
      expect(JSON.stringify(table.props.cells)).toContain(
        '"blockIds":["' + paragraph + '"]',
      );
      expect(tableImport.diagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      liveReadable.value = false;
      expect(tableImport.assertCurrent).toThrow(
        "Markdown import reference access lost",
      );
    } finally {
      liveReadable.value = true;
      tableImport.transformer[Symbol.dispose]();
    }
    const preview = new TestWorkspace({ id: "SLIDES_PREVIEW" });
    preview.storeExtensions = workspace.storeExtensions;
    preview.meta.initialize();
    const previewDoc = preview.createDoc("slide-preview");
    previewDoc.load();
    const previewStore = previewDoc.getStore();
    const previewRoot = previewStore.addBlock("myoxus:page");
    const surface = previewStore.addBlock("myoxus:surface", {}, previewRoot);
    let prepared: Awaited<ReturnType<typeof markdownToSnapshot>> | undefined;
    let templateJob: TemplateJob | undefined;
    try {
      prepared = await markdownToSnapshot(
        source + "\n\nPreview-only text ^preview-only\n\n[[#^preview-only]]",
        previewStore,
        host,
      );
      expect(prepared.diagnostics).toEqual({
        unresolvedReferences: 1,
        unsupportedReferences: 0,
      });
      expect(references(prepared.snapshot!)).toEqual(
        references(imported.snapshot!),
      );
      expect(prepared.snapshot!.workspaceId).toBe(workspace.id);
      expect(prepared.snapshot!.pageId).toBe(store.id);
      const template = {
        type: "page",
        meta: {
          id: previewStore.id,
          title: "Preview",
          createDate: 0,
          tags: [],
        },
        blocks: {
          type: "block",
          flavour: "myoxus:page",
          id: previewRoot,
          props: {},
          children: prepared.snapshot!.content,
        },
      };
      templateJob = new TemplateJob({
        model: previewStore.getModelById(surface) as SurfaceBlockModel,
        type: "template",
        middlewares: [],
      });
      const before = Object.keys(previewStore.blocks.peek());
      liveReadable.value = false;
      await expect(
        templateJob.insertTemplate(template, prepared.assertCurrent),
      ).rejects.toThrow("Markdown import reference access lost");
      expect(Object.keys(previewStore.blocks.peek())).toEqual(before);
      liveReadable.value = true;
      await templateJob.insertTemplate(template, prepared.assertCurrent);
      const inserted = previewStore.getBlocksByFlavour("myoxus:paragraph");
      expect(inserted).toHaveLength(3);
      expect(
        (inserted[0].model as ParagraphBlockModel).props.text
          .toDelta()
          .flatMap(
            (delta) => delta.attributes?.reference?.params?.blockIds ?? [],
          ),
      ).toEqual([heading, paragraph, local]);
      expect(
        (inserted[2].model as ParagraphBlockModel).props.text.toString(),
      ).toBe("[[#^preview-only]]");
    } finally {
      templateJob?.job[Symbol.dispose]();
      prepared?.transformer[Symbol.dispose]();
      liveReadable.value = true;
      preview.dispose();
    }
    const clipboardEvent = (items: Record<string, string>) =>
      ({
        clipboardData: {
          types: Object.keys(items),
          files: [],
          getData: (type: string) => items[type] ?? "",
        },
      }) as unknown as ClipboardEvent;
    const pasted = await std.clipboard.paste(
      clipboardEvent({ "text/plain": source }),
      store,
      note,
    );
    expect(pasted).toBeDefined();
    expect(
      std.clipboard
        .sliceToSnapshot(pasted!)!
        .content.flatMap((block) =>
          ((block.props.text as SnapshotText)?.delta ?? []).flatMap(
            (delta) => delta.attributes?.reference?.params?.blockIds ?? [],
          ),
        ),
    ).toEqual([heading, paragraph, local]);
    const htmlPaste = await std.clipboard.paste(
      clipboardEvent({
        "text/html": "<p><strong>HTML wins</strong></p>",
        "text/plain": source,
      }),
      store,
      note,
    );
    expect(htmlPaste).toBeDefined();
    expect(
      (
        std.clipboard.sliceToSnapshot(htmlPaste!)!.content[0].props
          .text as SnapshotText
      ).delta,
    ).toEqual([{ insert: "HTML wins", attributes: { bold: true } }]);
    const targetUrl = `${window.location.origin}/workspace/${workspace.id}/${target.id}`;
    const preciseHtml = `<p><a href="${targetUrl}?mode=page&amp;blockIds=${heading}">hea<strong>ding</strong></a> <a href="${targetUrl}#%5Einstruction">instruction</a> <a href="#%5Elocal">local</a></p>`;
    const htmlTargets = await std.clipboard.paste(
      clipboardEvent({
        "text/html": preciseHtml,
        "text/plain": "Must not win",
      }),
      store,
      note,
    );
    expect(htmlTargets).toBeDefined();
    expect(
      std.clipboard
        .sliceToSnapshot(htmlTargets!)!
        .content.flatMap((block) =>
          ((block.props.text as SnapshotText)?.delta ?? []).flatMap((delta) =>
            delta.attributes?.reference ? [delta.attributes.reference] : [],
          ),
        ),
    ).toEqual([
      expect.objectContaining({
        pageId: target.id,
        title: "heading",
        params: expect.objectContaining({ blockIds: [heading] }),
      }),
      {
        type: "LinkedPage",
        pageId: target.id,
        title: "instruction",
        params: { mode: "page", blockIds: [paragraph] },
      },
      {
        type: "LinkedPage",
        pageId: store.id,
        title: "local",
        params: { mode: "page", blockIds: [local] },
      },
    ]);
    vi.mocked(access.waitForLoaded).mockClear();
    const literalHtml = await std.clipboard.paste(
      clipboardEvent({
        "text/html": `<p><code><a href="${targetUrl}">literal</a></code> %% <a href="${targetUrl}">hidden</a> %%</p>`,
      }),
      store,
      note,
    );
    const literalDeltas = (
      std.clipboard.sliceToSnapshot(literalHtml!)!.content[0].props
        .text as SnapshotText
    ).delta;
    expect(literalDeltas.some((delta) => delta.attributes?.reference)).toBe(
      false,
    );
    expect(
      literalDeltas.find((delta) => delta.insert === "literal")?.attributes
        ?.code,
    ).toBe(true);
    expect(
      literalDeltas
        .filter((delta) => delta.attributes?.annotation)
        .map((delta) => delta.insert)
        .join(""),
    ).toContain("hidden");
    expect(access.waitForLoaded).not.toHaveBeenCalled();
    const beforeInsert = vi.fn(() => ({ parent: note }));
    const blockIds = Object.keys(store.blocks.peek());
    vi.mocked(access.waitForLoaded).mockRejectedValueOnce(
      new Error("Target loading failed"),
    );
    await expect(
      std.clipboard.paste(
        clipboardEvent({ "text/plain": "[[Target#^instruction|instruction]]" }),
        store,
        note,
        undefined,
        beforeInsert,
      ),
    ).rejects.toThrow("Target loading failed");
    expect(beforeInsert).not.toHaveBeenCalled();
    expect(Object.keys(store.blocks.peek())).toEqual(blockIds);
    vi.mocked(access.waitForLoaded).mockImplementationOnce(async () => {
      titleAvailable = false;
    });
    await expect(
      std.clipboard.paste(
        clipboardEvent({ "text/html": preciseHtml }),
        store,
        note,
        undefined,
        beforeInsert,
      ),
    ).rejects.toThrow("Markdown import reference access lost");
    expect(beforeInsert).not.toHaveBeenCalled();
    expect(Object.keys(store.blocks.peek())).toEqual(blockIds);
    titleAvailable = true;
    revokeAfterPreparation = true;
    await expect(
      std.clipboard.paste(
        clipboardEvent({ "text/plain": source + "\n\n" + tableSource }),
        store,
        note,
        undefined,
        beforeInsert,
      ),
    ).rejects.toThrow("Markdown import reference access lost");
    expect(beforeInsert).not.toHaveBeenCalled();
    expect(Object.keys(store.blocks.peek())).toEqual(blockIds);
    await expect(
      std.clipboard.paste(
        clipboardEvent({ "text/html": preciseHtml }),
        store,
        note,
        undefined,
        beforeInsert,
      ),
    ).rejects.toThrow("Markdown import reference access lost");
    expect(beforeInsert).not.toHaveBeenCalled();
    expect(Object.keys(store.blocks.peek())).toEqual(blockIds);
    revokeAfterPreparation = false;
    liveReadable.value = true;
    const internalClipboard = vi
      .spyOn(std.clipboard, "readFromClipboard")
      .mockReturnValueOnce({
        [ClipboardAdapter.MIME]: JSON.stringify({
          blobs: {},
          snapshot: { type: "slice", content: [], pageId: store.id },
        }),
      });
    const invalid = await std.clipboard.paste(
      clipboardEvent({}),
      store,
      note,
      undefined,
      beforeInsert,
    );
    expect(invalid).toBeUndefined();
    expect(beforeInsert).not.toHaveBeenCalled();
    expect(Object.keys(store.blocks.peek())).toEqual(blockIds);
    internalClipboard.mockRestore();
    const cancelled = await std.clipboard.paste(
      clipboardEvent({ "text/plain": source }),
      store,
      note,
      undefined,
      () => false,
    );
    expect(cancelled).toBeUndefined();
    expect(Object.keys(store.blocks.peek())).toEqual(blockIds);
    readable = false;
    vi.mocked(access.waitForLoaded).mockClear();
    vi.mocked(access.referenceTitle!).mockClear();
    const denied = await markdownToSnapshot(source, store, host);
    expect(denied.diagnostics).toEqual({
      unresolvedReferences: 2,
      unsupportedReferences: 0,
    });
    expect(references(denied.snapshot!).map((ref) => ref.pageId)).toEqual([
      store.id,
    ]);
    expect(access.waitForLoaded).not.toHaveBeenCalledWith(
      target.id,
      expect.anything(),
    );
    denied.transformer[Symbol.dispose]();
    const titleReads = vi.mocked(access.referenceTitle!);
    expect(
      await Promise.all(
        titleReads.mock.results
          .filter((_, index) => titleReads.mock.calls[index][0] === target.id)
          .map((result) => result.value),
      ),
    ).toEqual([undefined]);
    vi.mocked(access.waitForLoaded).mockClear();
    const deniedHtml = await std.clipboard.paste(
      clipboardEvent({
        "text/html": `<p><a href="${targetUrl}">denied</a> <a href="${window.location.origin}/workspace/foreign/${target.id}">foreign</a> <a href="${targetUrl}/suffix">prefix</a></p>`,
      }),
      store,
      note,
    );
    expect(
      (
        std.clipboard.sliceToSnapshot(deniedHtml!)!.content[0].props
          .text as SnapshotText
      ).delta.some((delta) => delta.attributes?.reference),
    ).toBe(false);
    expect(access.waitForLoaded).not.toHaveBeenCalled();
    readable = true;
    targetStore.deleteBlock(targetStore.getBlock(paragraph)!.model);
    const missing = await markdownToSnapshot(source, store, host);
    expect(missing.diagnostics).toEqual({
      unresolvedReferences: 1,
      unsupportedReferences: 0,
    });
    expect(
      references(missing.snapshot!).map((ref) => ref.params?.blockIds),
    ).toEqual([[heading], [local]]);
    missing.transformer[Symbol.dispose]();
    let finishLoad!: () => void;
    const load = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    vi.mocked(access.waitForLoaded).mockClear();
    vi.mocked(access.waitForLoaded).mockImplementationOnce(() => load);
    const beforeUnmount = Object.keys(store.blocks.peek());
    const pending = std.clipboard.paste(
      clipboardEvent({ "text/plain": "[[Target#Über Größe|heading]]" }),
      store,
      note,
      undefined,
      beforeInsert,
    );
    await vi.waitFor(() => expect(access.waitForLoaded).toHaveBeenCalledOnce());
    std.clipboard.unmounted();
    finishLoad();
    expect(await pending).toBeUndefined();
    expect(beforeInsert).not.toHaveBeenCalled();
    expect(Object.keys(store.blocks.peek())).toEqual(beforeUnmount);
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test("selection Markdown freezes the caret and retains exact native URLs outside the copied tree", async () => {
  const { workspace, store, note } = fixture();
  const target = workspace.createDoc("selection-target");
  target.load();
  workspace.meta.setDocMeta(target.id, { title: "Cached target" });
  const targetStore = target.getStore();
  const root = targetStore.addBlock("myoxus:page");
  const targetNote = targetStore.addBlock("myoxus:note", {}, root);
  const heading = targetStore.addBlock(
    "myoxus:paragraph",
    { type: "h2", text: new Text("Target heading") },
    targetNote,
  );
  const local = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Local instruction"), markdownAnchor: "local" },
    note,
  );
  const paragraph = store.addBlock(
    "myoxus:paragraph",
    {
      text: new Text<MyoxusTextAttributes>([
        { insert: "Before " },
        {
          insert: " ",
          attributes: {
            reference: {
              type: "LinkedPage",
              pageId: target.id,
              params: { mode: "page", blockIds: [heading] },
            },
          },
        },
        { insert: " " },
        {
          insert: " ",
          attributes: {
            reference: {
              type: "LinkedPage",
              pageId: store.id,
              title: "local",
              params: { mode: "page", blockIds: [local] },
            },
          },
        },
        { insert: " after" },
      ]),
    },
    note,
  );
  const access = fixtureReferenceAccess(workspace);
  const unselected = workspace.createDoc("unselected-rootless-target");
  unselected.load();
  store.addBlock(
    "myoxus:paragraph",
    {
      text: new Text<MyoxusTextAttributes>([
        {
          insert: " ",
          attributes: {
            reference: {
              type: "LinkedPage",
              pageId: unselected.id,
              params: { mode: "page", blockIds: ["missing"] },
            },
          },
        },
      ]),
    },
    note,
  );
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      { setup: (di) => di.addImpl(DocEmbedProvider, access) },
    ],
  });
  const host = { std, store, selection: std.selection } as EditorHost;
  std.selection.setGroup("note", [
    new TextSelection({
      from: { blockId: paragraph, index: 7, length: 3 },
      to: null,
    }),
  ]);
  access.waitForLoaded = async (id) => {
    if (id === target.id) {
      workspace.meta.setDocMeta(target.id, { title: "Current target" });
      std.selection.setGroup("note", [
        new TextSelection({
          from: { blockId: local, index: 0, length: 5 },
          to: null,
        }),
      ]);
    }
  };
  try {
    const source = await getContentFromSlice(
      host,
      Slice.fromModels(store, [store.getModelById(paragraph)!]),
    );
    expect(source).toContain("[Current target]");
    expect(source).not.toContain("Cached target");
    expect(source).not.toContain("Before");
    expect(source).not.toContain("after");
    using job = store.getTransformer();
    const links = await new MarkdownAdapter(
      job,
      store.provider,
    ).toBlockSnapshot({ file: source });
    const urls = (links.children[0].props.text as SnapshotText).delta.flatMap(
      ({ attributes }) => (attributes?.link ? [attributes.link] : []),
    );
    expect(
      urls.map((url) => new URL(url).searchParams.get("blockIds")),
    ).toEqual([heading, local]);
    expect(urls.every((url) => new URL(url).hash === "")).toBe(true);
    targetStore.deleteBlock(heading);
    std.selection.setGroup("note", [
      new TextSelection({
        from: { blockId: paragraph, index: 7, length: 3 },
        to: null,
      }),
    ]);
    const missing = await getContentFromSlice(
      host,
      Slice.fromModels(store, [store.getModelById(paragraph)!]),
    );
    expect(missing).not.toContain(heading);
    expect(missing).toContain(local);
    access.canRead = async (id) => id !== target.id;
    workspace.meta.setDocMeta(target.id, {
      title: "Confidential denied title",
    });
    const denied = await getContentFromSlice(
      host,
      Slice.fromModels(store, [store.getModelById(paragraph)!]),
    );
    expect(denied).not.toContain("Confidential denied title");
    expect(denied).not.toContain("Cached target");
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test("selection plain-text embed expansion checks read access before cached bodies and loads current content", async () => {
  const { workspace, store, note } = fixture();
  const target = workspace.createDoc("plain-target");
  target.load();
  const targetStore = target.getStore();
  const root = targetStore.addBlock("myoxus:page");
  const targetNote = targetStore.addBlock("myoxus:note", {}, root);
  const body = targetStore.addBlock(
    "myoxus:paragraph",
    { text: new Text("Cached confidential body") },
    targetNote,
  );
  workspace.meta.setDocMeta(target.id, { title: "Cached confidential title" });
  const embed = store.addBlock(
    "myoxus:embed-synced-doc",
    { pageId: target.id },
    note,
  );
  let readable = false;
  const access: DocEmbedProvider = {
    canRead: async (id) => id === store.id || readable,
    readable: (id) => signal(id === store.id || readable),
    waitForLoaded: vi.fn(async (id) => {
      if (id === target.id)
        targetStore
          .getModelById(body)!
          .text!.replace(
            0,
            "Cached confidential body".length,
            "Current loaded body",
          );
    }),
  };
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      { setup: (di) => di.addImpl(DocEmbedProvider, access) },
    ],
  });
  const host = { std, store, selection: std.selection } as EditorHost;
  const slice = Slice.fromModels(store, [store.getModelById(embed)!]);
  try {
    await expect(
      getContentFromSlice(host, slice, "plain-text"),
    ).rejects.toThrow("Plain-text embed access denied");
    expect(access.waitForLoaded).not.toHaveBeenCalledWith(
      target.id,
      expect.anything(),
    );
    readable = true;
    const source = await getContentFromSlice(host, slice, "plain-text");
    expect(source).toContain("Current loaded body");
    expect(source).not.toContain("Cached confidential");
    expect(access.waitForLoaded).toHaveBeenCalledWith(
      target.id,
      expect.any(AbortSignal),
    );
    access.waitForLoaded = async () => {};
    const rootless = workspace.createDoc("registered-rootless-embed");
    rootless.load();
    expect(rootless.getStore().root).toBeNull();
    store.updateBlock(store.getModelById(embed)!, { pageId: rootless.id });
    await expect(
      getContentFromSlice(
        host,
        Slice.fromModels(store, [store.getModelById(embed)!]),
        "plain-text",
      ),
    ).rejects.toThrow("Plain-text embed target missing");
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test("native clipboard retains the live reference fence between insertion writes", async () => {
  const { workspace, store, note } = fixture();
  const readable = signal(true);
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      ClipboardAdapterConfigExtension({
        mimeType: "text/plain",
        adapter: MixTextAdapter,
        priority: 70,
      }),
      {
        setup: (di) =>
          di.addImpl(DocEmbedProvider, {
            canRead: async () => readable.value,
            readable: () => readable,
            waitForLoaded: async () => {},
          }),
      },
    ],
  });
  std.clipboard.use(documentReferenceMiddleware([]));
  std.clipboard.use(pasteMiddleware(std));
  std.clipboard.use(({ slots }) => {
    const subscription = slots.afterImport.subscribe((payload) => {
      if (payload.type === "block") readable.value = false;
    });
    return () => subscription.unsubscribe();
  });
  const before = Object.keys(store.blocks.peek());
  const source =
    "[[#Fence heading|heading]]\n\n## Fence heading\n\nLast instruction.";
  try {
    await expect(
      std.clipboard.paste(
        {
          clipboardData: {
            types: ["text/plain"],
            files: [],
            getData: () => source,
          },
        } as unknown as ClipboardEvent,
        store,
        note,
      ),
    ).rejects.toThrow("Markdown import reference access lost");
    // No false rollback claim: one permitted write happened before revocation.
    const added = Object.keys(store.blocks.peek()).filter(
      (id) => !before.includes(id),
    );
    expect(added).toHaveLength(1);
    expect(store.getModelById(added[0])!.text!.toString()).not.toBe(
      "Last instruction.",
    );
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test.each([
  {
    first: "Release instruction. ^incoming",
    fragment: "^incoming",
    label: "Release instruction.",
  },
  {
    first: "## Fresh release",
    fragment: "Fresh release",
    label: "Fresh release",
  },
  {
    first: "## Fresh release",
    fragment: "Fresh release",
    label: "Fresh release",
    emptyDestination: true,
  },
])(
  "native paste preserves incoming first targets through merge and ID replacement ($fragment)",
  async ({ first, fragment, label, emptyDestination = false }) => {
    const { workspace, store, note } = fixture();
    const destination = store.addBlock(
      "myoxus:paragraph",
      { text: new Text(emptyDestination ? "" : "Before after") },
      note,
    );
    const std = new BlockStdScope({
      store,
      extensions: [
        ...workspace.storeExtensions,
        ParseDocUrlExtension({
          parseDocUrl: (url) =>
            url.startsWith(
              `${window.location.origin}/workspace/${workspace.id}/${store.id}`,
            )
              ? { docId: store.id }
              : undefined,
        }),
        ClipboardAdapterConfigExtension({
          mimeType: ClipboardAdapter.MIME,
          adapter: ClipboardAdapter,
          priority: 100,
        }),
        ClipboardAdapterConfigExtension({
          mimeType: "text/plain",
          adapter: MixTextAdapter,
          priority: 70,
        }),
        {
          setup: (di) =>
            di.addImpl(DocEmbedProvider, fixtureReferenceAccess(workspace)),
        },
      ],
    });
    // A replacement boundary can exist in the model before its view mounts.
    // The desktop journey separately verifies selection, focus and navigation.
    vi.spyOn(std.view, "getBlock").mockReturnValue(null);
    vi.spyOn(std, "host", "get").mockReturnValue({
      updateComplete: Promise.resolve(),
      querySelector: () => null,
    } as unknown as EditorHost);
    std.clipboard.use(pasteMiddleware(std));
    std.clipboard.use(documentReferenceMiddleware([]));
    std.clipboard.use(docLinkBaseURLMiddleware(workspace.id));
    std.clipboard.use(replaceIdMiddleware(workspace.idGenerator));
    std.selection.setGroup("note", [
      new TextSelection({
        from: {
          blockId: destination,
          index: emptyDestination ? 0 : 7,
          length: 0,
        },
        to: null,
      }),
    ]);
    const clipboardEvent = (items: Record<string, string>) =>
      ({
        clipboardData: {
          types: Object.keys(items),
          files: [],
          getData: (type: string) => items[type] ?? "",
        },
      }) as unknown as ClipboardEvent;
    const missingUrl = `${window.location.origin}/workspace/${workspace.id}/${store.id}?mode=page&blockIds=deleted-native-target`;
    const source = `${first}\n\n[[#${fragment}|instruction]]\n\n> [!note]\n> [[#${fragment}|callout instruction]]\n\n| Target |\n| --- |\n| [[#${fragment}\\|table instruction]] |\n\n\`[[#${fragment}]]\`\n\n%%[[#${fragment}]]%%\n\n[missing instruction](${missingUrl})\n\nEnd.`;
    try {
      const pasted = await std.clipboard.paste(
        clipboardEvent({ "text/plain": source }),
        store,
        note,
        1,
      );
      expect(pasted).toBeDefined();
      const target = store
        .getBlocksByFlavour("myoxus:paragraph")
        .find(({ model }) => model.text?.toString() === label)!.model;
      expect(target.id).not.toBe(destination);
      if (emptyDestination) {
        expect(store.getModelById(destination)).toBeNull();
        expect(
          store
            .getBlocksByFlavour("myoxus:paragraph")
            .some(({ model }) => model.text!.length === 0),
        ).toBe(false);
      } else
        expect(store.getModelById(destination)!.text!.toString()).toBe(
          "Before ",
        );
      expect(
        store
          .getBlocksByFlavour("myoxus:paragraph")
          .find(
            ({ model }) =>
              model.text?.toString() ===
              (emptyDestination ? "End." : "End.after"),
          ),
      ).toBeDefined();
      // Read live models: post-paste convenience conversion runs after the
      // returned Slice's drafts were captured, so those drafts can be stale.
      const native = std.clipboard.sliceToSnapshot(
        Slice.fromModels(
          store,
          pasted!.content.map(({ id }) => store.getModelById(id)!),
        ),
      )!;
      const importedBlocks: BlockSnapshot[] = [];
      const pending = [...native.content];
      while (pending.length) {
        const block = pending.pop()!;
        importedBlocks.push(block);
        pending.push(...block.children);
      }
      const references = importedBlocks.flatMap((block) => {
        const texts =
          block.flavour === "myoxus:table"
            ? Object.values(
                block.props.cells as Record<string, { text: SnapshotText }>,
              ).map(({ text }) => text)
            : block.flavour === "myoxus:annotation"
              ? []
              : [block.props.text as SnapshotText | undefined];
        return texts.flatMap((text) =>
          (text?.delta ?? []).flatMap(({ attributes }) =>
            attributes?.reference ? [attributes.reference] : [],
          ),
        );
      });
      expect(references.map(({ title }) => title).sort()).toEqual([
        "callout instruction",
        "instruction",
        "table instruction",
      ]);
      expect(
        importedBlocks.some((block) =>
          (block.props.text as SnapshotText | undefined)?.delta.some(
            ({ attributes }) =>
              attributes?.link === missingUrl && !attributes.reference,
          ),
        ),
      ).toBe(true);
      expect(
        references.map(({ pageId, params }) => ({ pageId, params })),
      ).toEqual(
        Array.from({ length: 3 }, () => ({
          pageId: store.id,
          params: { mode: "page", blockIds: [target.id] },
        })),
      );
      expect(
        store
          .getBlocksByFlavour("myoxus:annotation")
          .at(-1)!
          .model.text!.toString(),
      ).toBe(`[[#${fragment}]]`);
      expect(
        store
          .getBlocksByFlavour("myoxus:paragraph")
          .some(({ model }) =>
            model.text
              ?.toDelta()
              .some(
                ({ attributes }) => attributes?.code && !attributes.reference,
              ),
          ),
      ).toBe(true);

      std.selection.setGroup("note", []);
      const copied = await std.clipboard.paste(
        clipboardEvent({
          [ClipboardAdapter.MIME]: JSON.stringify({
            snapshot: native,
            blobs: {},
          }),
        }),
        store,
        note,
      );
      expect(copied).toBeDefined();
      const copiedReference = copied!.content
        .flatMap((model) => model.text?.toDelta() ?? [])
        .find(({ attributes }) => attributes?.reference)?.attributes?.reference;
      expect(copiedReference?.params?.blockIds).toEqual([target.id]);
      expect(copied!.content.some((model) => model.id === target.id)).toBe(
        false,
      );

      // Repeated source anchors/headings in one destination cannot choose either
      // the original live block or a newly inserted copy arbitrarily.
      const ambiguous = await markdownToSnapshot(
        `${first}\n\n[[#${fragment}|ambiguous]]`,
        store,
        { std, store } as EditorHost,
      );
      expect(ambiguous.diagnostics.unresolvedReferences).toBe(1);
      expect(
        (
          ambiguous.snapshot!.content[0].children[1].props.text as SnapshotText
        ).delta.some(({ attributes }) => attributes?.reference),
      ).toBe(false);
      ambiguous.transformer[Symbol.dispose]();
    } finally {
      std.unmount();
      workspace.dispose();
    }
  },
);

test.each(["override", "append"] as const)(
  "Integration %s prepares exact native targets before destructive writes and fences live access",
  async (updateStrategy) => {
    const { workspace, store, note } = fixture();
    const original = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Original release draft."), markdownAnchor: "old" },
      note,
    );
    const targetDoc = workspace.createDoc("integration-current-target");
    targetDoc.load();
    workspace.meta.setDocMeta(targetDoc.id, { title: "Target" });
    const targetStore = targetDoc.getStore();
    const root = targetStore.addBlock("myoxus:page", {
      title: new Text("Target"),
    });
    const targetNote = targetStore.addBlock("myoxus:note", {}, root);
    const target = targetStore.addBlock(
      "myoxus:paragraph",
      { type: "h2", text: new Text("Über Größe") },
      targetNote,
    );
    const writable = new LiveData<boolean | undefined>(true);
    const readable = new LiveData<boolean | undefined>(true);
    let failLoad = false;
    let revokeOnTargetLoad = false;
    const release = vi.fn();
    const guard = {
      can: vi.fn(async (action: string) =>
        action === "Doc_Update"
          ? writable.value === true
          : readable.value === true,
      ),
      can$: (action: string) => (action === "Doc_Update" ? writable : readable),
      revalidateDocPermissionIfMissing: vi.fn(),
    };
    const docs = {
      list: {
        doc$: (id: string) =>
          new LiveData({
            title$: new LiveData(workspace.meta.getDocMeta(id)?.title ?? ""),
            trash$: new LiveData(false),
          }),
      },
      open: vi.fn((id: string) => ({
        doc: {
          virgultumDoc: workspace.getDoc(id)!,
          waitForSyncReady: async () => {
            if (id === targetDoc.id) {
              if (failLoad) throw new Error("Target sync failed");
              if (revokeOnTargetLoad) writable.next(false);
            }
          },
        },
        release,
      })),
    };
    const workspaceService = {
      workspace: {
        docCollection: workspace,
        scope: {
          get: (service: unknown) =>
            service === GuardService
              ? guard
              : service === DocsService
                ? docs
                : undefined,
        },
      },
    } as unknown as WorkspaceService;
    const framework = new Framework();
    framework
      .service(WorkspaceService, workspaceService)
      .service(TagService, {} as TagService)
      .entity(IntegrationWriter, [WorkspaceService, TagService]);
    const writer = framework.provider().createEntity(IntegrationWriter);
    const content =
      "New release instruction. ^new\n\n[[Target#Über Größe|external heading]] [[#^new|new instruction]] [[#^old|old instruction]]";
    const originalIds = Object.keys(store.blocks.peek());
    const options = { docId: store.id, content, updateStrategy };
    try {
      failLoad = true;
      await expect(writer.writeDoc(options)).rejects.toThrow(
        "Target sync failed",
      );
      expect(Object.keys(store.blocks.peek())).toEqual(originalIds);
      expect(store.getModelById(original)!.text!.toString()).toBe(
        "Original release draft.",
      );
      failLoad = false;
      revokeOnTargetLoad = true;
      await expect(writer.writeDoc(options)).rejects.toThrow(
        "Document update no longer available",
      );
      expect(Object.keys(store.blocks.peek())).toEqual(originalIds);
      revokeOnTargetLoad = false;
      writable.next(true);
      expect(await writer.writeDoc(options)).toBe(store.id);
      const incoming = store
        .getBlocksByFlavour("myoxus:paragraph")
        .find(
          ({ model }) => model.text?.toString() === "New release instruction.",
        )!.model;
      const references = store
        .getBlocksByFlavour("myoxus:paragraph")
        .flatMap(({ model }) => model.text!.toDelta())
        .flatMap(({ attributes }) =>
          attributes?.reference ? [attributes.reference] : [],
        );
      expect(references.map(({ title }) => title)).toEqual(
        updateStrategy === "override"
          ? ["external heading", "new instruction"]
          : ["external heading", "new instruction", "old instruction"],
      );
      expect(
        references.find(({ title }) => title === "external heading")?.params
          ?.blockIds,
      ).toEqual([target]);
      expect(
        references.find(({ title }) => title === "new instruction")?.params
          ?.blockIds,
      ).toEqual([incoming.id]);
      if (updateStrategy === "append")
        expect(
          references.find(({ title }) => title === "old instruction")?.params
            ?.blockIds,
        ).toEqual([original]);
      else expect(store.getModelById(original)).toBeNull();
      expect(release).toHaveBeenCalledTimes(docs.open.mock.calls.length);

      const ids = Object.keys(store.blocks.peek());
      writable.next(false);
      await expect(writer.writeDoc(options)).rejects.toThrow(
        "Document update denied",
      );
      expect(Object.keys(store.blocks.peek())).toEqual(ids);
      writable.next(true);
      readable.next(false);
      await expect(writer.writeDoc(options)).rejects.toThrow(
        "Document embed access denied",
      );
      expect(Object.keys(store.blocks.peek())).toEqual(ids);
    } finally {
      writer.dispose();
      workspace.dispose();
    }
  },
);

function fixture(workspaceId = "annotation-interchange-workspace") {
  const workspace = new TestWorkspace({
    id: workspaceId,
  });
  workspace.storeExtensions = getStoreManager()
    .config.init()
    .value.get("store");
  workspace.meta.initialize();
  const doc = workspace.createDoc("annotation-core-interchange");
  doc.load();
  const store = doc.getStore();
  const root = store.addBlock("myoxus:page", {
    title: new Text("Annotations"),
  });
  const note = store.addBlock("myoxus:note", {}, root);
  return { workspace, store, note };
}

test.each([
  ["readonly", ReadOnlyClipboard],
  ["page", PageClipboard],
  ["edgeless", EdgelessClipboardController],
] as const)(
  "native %s copy freezes one selection and guards both HTML and mixed text target metadata",
  async (_name, ClipboardOwner) => {
    const { workspace, store, note } = fixture();
    const target = workspace.createDoc("copy-target");
    target.load();
    workspace.meta.setDocMeta(target.id, { title: "Cached target" });
    const targetStore = target.getStore();
    const targetRoot = targetStore.addBlock("myoxus:page");
    const targetNote = targetStore.addBlock("myoxus:note", {}, targetRoot);
    const heading = targetStore.addBlock(
      "myoxus:paragraph",
      { type: "h2", text: new Text("Release review") },
      targetNote,
    );
    const local = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Local decision"), markdownAnchor: "local" },
      note,
    );
    const source = store.addBlock(
      "myoxus:paragraph",
      {
        text: new Text<MyoxusTextAttributes>([
          { insert: "Open " },
          {
            insert: " ",
            attributes: {
              reference: {
                type: "LinkedPage",
                pageId: target.id,
                params: { mode: "page", blockIds: [heading] },
              },
            },
          },
          { insert: " and " },
          {
            insert: " ",
            attributes: {
              reference: {
                type: "LinkedPage",
                pageId: store.id,
                title: "local decision",
                params: { mode: "page", blockIds: [local] },
              },
            },
          },
          { insert: ". " },
          {
            insert: "private [[literal]]",
            attributes: { annotation: { id: "copy-annotation" } },
          },
        ]),
      },
      note,
    );
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1EAAAAASUVORK5CYII=";
    const imageBytes = Uint8Array.from(atob(imageBase64), (char) =>
      char.charCodeAt(0),
    );
    const imageId = await workspace.blobSync.set(
      new Blob([imageBytes], { type: "image/png" }),
    );
    const image = store.addBlock("myoxus:image", { sourceId: imageId }, note);
    const preciseText = (title: string) =>
      new Text<MyoxusTextAttributes>([
        {
          insert: " ",
          attributes: {
            reference: {
              type: "LinkedPage",
              pageId: target.id,
              title,
              params: { mode: "page", blockIds: [heading] },
            },
          },
        },
      ]);
    const callout = store.addBlock(
      "myoxus:callout",
      {
        type: "note",
        text: preciseText("callout release"),
        markdownAnchor: "original-callout",
      },
      note,
    );
    store.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("One child, not duplicated"),
        markdownAnchor: "original-child",
      },
      callout,
    );
    const table = store.addBlock(
      "myoxus:table",
      {
        rows: { r: { rowId: "r", order: "a0" } },
        columns: { c: { columnId: "c", order: "a0" } },
        cells: { "r:c": { text: preciseText("table release") } },
      },
      note,
    );
    const permission = signal(true);
    let moveSelectionWhileLoading = true;
    const access: DocEmbedProvider = {
      canRead: async (id) => id === store.id || permission.value,
      readable: (id) => (id === store.id ? signal(true) : permission),
      waitForLoaded: vi.fn(async (id) => {
        if (id === target.id) {
          workspace.meta.setDocMeta(target.id, { title: "Current target" });
          if (moveSelectionWhileLoading)
            std.selection.setGroup("note", [
              new TextSelection({
                from: { blockId: local, index: 0, length: 5 },
                to: null,
              }),
            ]);
        }
      }),
    };
    const std = new BlockStdScope({
      store,
      extensions: [
        ...workspace.storeExtensions,
        ...clipboardConfigs,
        ClipboardOwner,
        { setup: (di) => di.addImpl(DocEmbedProvider, access) },
      ],
    });
    const host = {
      std,
      store,
      selection: std.selection,
      updateComplete: Promise.resolve(),
      querySelector: () => null,
    } as unknown as EditorHost;
    vi.spyOn(std, "host", "get").mockReturnValue(host);
    const previousClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writes: Record<string, Blob>[][] = [];
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    // Canvas-specific mounting is outside this adapter test; the inherited
    // copy preparation still runs before installing the OS clipboard boundary.
    Reflect.deleteProperty(navigator, "clipboard");
    std.get(ClipboardOwner).mounted();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn(async (items: TestClipboardItem[]) => {
          writes.push(items.map((item) => item.items));
        }),
      },
    });
    const select = () =>
      std.selection.setGroup("note", [
        new TextSelection({
          from: {
            blockId: source,
            index: 0,
            length: store.getModelById(source)!.text!.length,
          },
          to: null,
        }),
      ]);
    try {
      select();
      await std.clipboard.copySlice(
        Slice.fromModels(store, [
          store.getModelById(source)!,
          store.getModelById(image)!,
          store.getModelById(callout)!,
          store.getModelById(table)!,
        ]),
      );
      const first = writes[0][0];
      const plain = await first["text/plain"].text();
      expect(plain).toContain("Current target");
      expect(plain).not.toContain("Cached target");
      expect(plain).toContain("%%private [[literal]]%%");
      expect(plain).toContain(`blockIds=${heading}`);
      expect(plain).toContain(`blockIds=${local}`);
      expect(plain).not.toContain("#local");
      expect(plain).toContain("[!note]");
      expect(plain).toContain(`[callout release](`);
      const markdownTable = new DOMParser()
        .parseFromString(plain.match(/<table>.*<\/table>/s)![0], "text/html")
        .querySelector("table")!;
      expect(markdownTable.querySelector("thead")).toBeNull();
      const tableLink = markdownTable.querySelector("tbody td a")!;
      expect(tableLink.textContent).toBe("table release");
      expect(
        new URL(tableLink.getAttribute("href")!).searchParams.get("blockIds"),
      ).toBe(heading);
      expect(plain.match(/One child, not duplicated/g)).toHaveLength(1);
      expect(plain).toContain("> One child, not duplicated");
      expect(plain).not.toContain("^original-callout");
      expect(plain).not.toContain("^original-child");
      expect(plain.match(new RegExp(`blockIds=${heading}`, "g"))).toHaveLength(
        3,
      );
      const copied = await markdownToSnapshot(plain, store, host);
      try {
        const copiedBlocks = copied.snapshot!.content[0].children;
        const copiedCallout = copiedBlocks.find(
          (block) => block.flavour === "myoxus:callout",
        );
        expect(copiedCallout).toBeDefined();
        expect(copiedCallout!.children).toHaveLength(1);
        expect(
          (copiedCallout!.children[0].props.text as SnapshotText).delta
            .map((delta) => delta.insert)
            .join(""),
        ).toBe("One child, not duplicated");
        expect(
          copiedBlocks.filter((block) => block.flavour === "myoxus:table"),
        ).toHaveLength(1);
        const copiedTable = copiedBlocks.find(
          (block) => block.flavour === "myoxus:table",
        )!;
        expect(copiedTable.props.headerRows).toBe(0);
        expect(JSON.stringify(copiedTable.props.cells)).toContain(
          '"pageId":"' + target.id + '"',
        );
        expect(JSON.stringify(copiedTable.props.cells)).toContain(
          '"blockIds":["' + heading + '"]',
        );
      } finally {
        copied.transformer[Symbol.dispose]();
      }
      const html = await first["text/html"].text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      expect(
        [...parsed.querySelectorAll("a")].map((link) =>
          new URL(link.href).searchParams.get("blockIds"),
        ),
      ).toEqual([heading, local, heading, heading]);
      expect(parsed.body.textContent).toContain("Current target");
      expect(parsed.body.textContent).not.toContain("private [[literal]]");
      // Check the actual OS payload here. Native sanitization/paste is exercised
      // in the desktop browser, not Happy DOM's incomplete sanitizer host.
      const encoded = parsed
        .querySelector("[data-virgultum-snapshot]")!
        .getAttribute("data-virgultum-snapshot")!;
      const serialized = decodeClipboardSnapshot(encoded);
      const native = JSON.parse(serialized[ClipboardAdapter.MIME]).snapshot as {
        content: BlockSnapshot[];
      };
      expect(
        (
          native.content[0].children[0].props.text as SnapshotText
        ).delta.flatMap((delta) =>
          delta.attributes?.reference
            ? [delta.attributes.reference.params?.blockIds]
            : [],
        ),
      ).toEqual([[heading], [local]]);
      const blobs = JSON.parse(serialized[ClipboardAdapter.MIME]).blobs;
      expect(blobs[imageId].type).toBe("image/png");
      expect(blobs[imageId].content).toBe(imageBase64);
      if (ClipboardOwner === PageClipboard) {
        moveSelectionWhileLoading = false;
        std.selection.setGroup("note", []);
        await std.clipboard.duplicateSlice(
          Slice.fromModels(targetStore, [targetStore.getModelById(heading)!]),
          store,
          note,
        );
        const duplicated = store
          .getModelById(note)!
          .children.find(
            (model) => model.text?.toString() === "Release review",
          );
        expect(duplicated).toBeDefined();
        expect(duplicated!.id).not.toBe(heading);
        expect(targetStore.getModelById(heading)?.text?.toString()).toBe(
          "Release review",
        );
        moveSelectionWhileLoading = true;
      }
      targetStore.deleteBlock(heading);
      select();
      await std.clipboard.copySlice(
        Slice.fromModels(store, [store.getModelById(source)!]),
      );
      const missing = new DOMParser().parseFromString(
        await writes[1][0]["text/html"].text(),
        "text/html",
      );
      expect(missing.querySelectorAll("a")).toHaveLength(1);
      expect(await writes[1][0]["text/plain"].text()).not.toContain(heading);
      permission.value = false;
      workspace.meta.setDocMeta(target.id, { title: "Confidential title" });
      select();
      await std.clipboard.copySlice(
        Slice.fromModels(store, [store.getModelById(source)!]),
      );
      expect(await writes[2][0]["text/plain"].text()).not.toContain(
        "Confidential title",
      );
      expect(await writes[2][0]["text/html"].text()).not.toContain(
        "Confidential title",
      );
      permission.value = true;
      targetStore.addBlock(
        "myoxus:paragraph",
        { id: heading, type: "h2", text: new Text("Restored review") },
        targetNote,
      );
      const exportMixedText = MixTextAdapter.prototype.fromSliceSnapshot;
      vi.spyOn(
        MixTextAdapter.prototype,
        "fromSliceSnapshot",
      ).mockImplementationOnce(async function (this: MixTextAdapter, payload) {
        const result = await exportMixedText.call(this, payload);
        permission.value = false;
        return result;
      });
      select();
      await expect(
        std.clipboard.copySlice(
          Slice.fromModels(store, [store.getModelById(source)!]),
        ),
      ).rejects.toThrow("access lost");
      expect(writes).toHaveLength(3);
      permission.value = true;
      vi.spyOn(
        HtmlAdapter.prototype,
        "fromSliceSnapshot",
      ).mockRejectedValueOnce(new Error("Copy conversion failed"));
      select();
      await expect(
        std.clipboard.copySlice(
          Slice.fromModels(store, [store.getModelById(source)!]),
        ),
      ).rejects.toThrow("Copy conversion failed");
      expect(writes).toHaveLength(3);
      expect(store.getModelById(source)?.text?.toString()).toBe(
        "Open   and  . private [[literal]]",
      );
    } finally {
      std.unmount();
      workspace.dispose();
      vi.unstubAllGlobals();
      if (previousClipboard)
        Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  },
);

test.each(["unchanged", "selection", "content", "readonly"] as const)(
  "page cut deletes only its unchanged copied source (%s)",
  async (change) => {
    const { workspace, store, note } = fixture();
    const source = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Keep Anna's instruction") },
      note,
    );
    const other = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Other instruction") },
      note,
    );
    let changed = false;
    const access: DocEmbedProvider = {
      ...fixtureReferenceAccess(workspace),
      canRead: async () => {
        // Copy yields at the source guard even when it no longer reloads a body.
        if (!changed) {
          changed = true;
          if (change === "selection")
            std.selection.setGroup("note", [
              new BlockSelection({ blockId: other }),
            ]);
          if (change === "content")
            store.getModelById(source)!.text!.insert(" (updated)", 23);
          if (change === "readonly") store.readonly = true;
        }
        return true;
      },
    };
    const std = new BlockStdScope({
      store,
      extensions: [
        ...workspace.storeExtensions,
        ...clipboardConfigs,
        PageClipboard,
        { setup: (di) => di.addImpl(DocEmbedProvider, access) },
      ],
    });
    const host = {
      std,
      store,
      updateComplete: Promise.resolve(),
    } as unknown as EditorHost;
    vi.spyOn(std, "host", "get").mockReturnValue(host);
    vi.spyOn(std.view, "getBlock").mockImplementation((id) => {
      const model = store.getModelById(id);
      return model ? ({ model } as BlockComponent) : null;
    });
    vi.spyOn(std.view, "walkThrough").mockImplementation(() => {});
    const previousClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Reflect.deleteProperty(navigator, "clipboard");
    const owner = std.get(PageClipboard);
    owner.mounted();
    const write = vi.fn(async () => {});
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: unknown) {}
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    // Await the real command's asynchronous copy plus its deletion callback;
    // no mocked exporter or deletion result can satisfy these assertions.
    const copy = std.clipboard.copy;
    let copied: Promise<void> | undefined;
    vi.spyOn(std.clipboard, "copy").mockImplementation((slice) => {
      copied = copy(slice);
      return copied;
    });
    try {
      std.selection.setGroup("note", [new BlockSelection({ blockId: source })]);
      const preventDefault = vi.fn();
      owner.onPageCut({
        get: () => ({ raw: { preventDefault } }),
      } as unknown as Parameters<typeof owner.onPageCut>[0]);
      await vi.waitFor(() => expect(copied).toBeDefined());
      await copied;
      await Promise.resolve();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      if (change === "unchanged") expect(store.getModelById(source)).toBeNull();
      else
        expect(store.getModelById(source)?.text?.toString()).toBe(
          "Keep Anna's instruction" +
            (change === "content" ? " (updated)" : ""),
        );
      expect(store.getModelById(other)?.text?.toString()).toBe(
        "Other instruction",
      );
    } finally {
      std.unmount();
      workspace.dispose();
      vi.unstubAllGlobals();
      if (previousClipboard)
        Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  },
);

function fixtureReferenceAccess(workspace: TestWorkspace): DocEmbedProvider {
  return {
    canRead: async (id) => !!workspace.meta.getDocMeta(id),
    readable: (id) => signal(!!workspace.meta.getDocMeta(id)),
    waitForLoaded: async (id) => {
      if (!workspace.getDoc(id)?.getStore().root)
        throw new Error("Fixture reference target missing");
    },
  };
}

test("Core replacement retains its native ID, full incoming content and local targets", async () => {
  const { workspace, store, note } = fixture();
  const original = store.addBlock(
    "myoxus:paragraph",
    {
      text: new Text("Original review heading"),
      markdownAnchor: "review-provenance",
      type: "h2",
    },
    note,
  );
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      {
        setup: (di) =>
          di.addImpl(DocEmbedProvider, fixtureReferenceAccess(workspace)),
      },
    ],
  });
  const host = { store, std } as EditorHost;
  try {
    const models = await replaceFromMarkdown(
      host,
      "## Release review\n\nReturn to [[#Release review|review heading]].\n\nKeep the final instruction.",
      store,
      note,
      0,
      original,
    );
    expect(models).toHaveLength(3);
    expect(models[0].id).toBe(original);
    expect(models[0].text?.toString()).toBe("Release review");
    expect((models[0] as ParagraphBlockModel).props.markdownAnchor).toBe(
      "review-provenance",
    );
    const references = models[1].text
      ?.toDelta()
      .flatMap((delta) =>
        delta.attributes?.reference ? [delta.attributes.reference] : [],
      );
    expect(references).toMatchObject([
      {
        pageId: store.id,
        params: { blockIds: [original], mode: "page" },
      },
    ]);
    expect(models[2].text?.toString()).toBe("Keep the final instruction.");
    expect(store.getModelById(note)?.children.map(({ id }) => id)).toEqual(
      models.map(({ id }) => id),
    );
    await expect(
      insertFromMarkdown(host, "Replacement", store, note, 0, original),
    ).rejects.toThrow("collision");
    expect(store.getModelById(original)?.text?.toString()).toBe(
      "Release review",
    );
    await expect(
      replaceFromMarkdown(host, "", store, note, 0, original),
    ).rejects.toThrow("Empty Markdown replacement");
    expect(store.getModelById(original)?.text?.toString()).toBe(
      "Release review",
    );
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test("AI patch acceptance inserts, replaces and deletes real native Markdown blocks", async () => {
  const { workspace, store, note } = fixture();
  const original = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Original review") },
    note,
  );
  const untouched = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Retain Anna's instruction") },
    note,
  );
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      {
        setup: (di) =>
          di.addImpl(DocEmbedProvider, fixtureReferenceAccess(workspace)),
      },
    ],
  });
  const host = { store, std } as EditorHost;
  try {
    await applyPatchToDoc(
      store,
      [
        {
          op: "insert",
          index: 1,
          after: original,
          block: {
            id: "inserted-review",
            type: "myoxus:paragraph",
            content:
              "## Inserted review\n\nFollow [[#Inserted review|inserted]].",
          },
        },
      ],
      host,
    );
    expect(store.getModelById("inserted-review")?.text?.toString()).toBe(
      "Inserted review",
    );
    const insertedReference = store.getModelById(note)!.children[2];
    expect(
      insertedReference.text
        ?.toDelta()
        .flatMap((delta) =>
          delta.attributes?.reference
            ? [delta.attributes.reference.params?.blockIds]
            : [],
        ),
    ).toEqual([["inserted-review"]]);
    await applyPatchToDoc(
      store,
      [
        {
          op: "replace",
          id: original,
          content:
            "## Current review\n\nFollow [[#Current review|current]].\n\nRetain the release checklist.",
        },
      ],
      host,
    );
    expect(store.getModelById(original)?.text?.toString()).toBe(
      "Current review",
    );
    const replaced = store.getModelById(note)!.children;
    expect(
      replaced[1].text
        ?.toDelta()
        .flatMap((delta) =>
          delta.attributes?.reference
            ? [delta.attributes.reference.params?.blockIds]
            : [],
        ),
    ).toEqual([[original]]);
    expect(replaced[2].text?.toString()).toBe("Retain the release checklist.");
    await applyPatchToDoc(
      store,
      [{ op: "delete", id: "inserted-review" }],
      host,
    );
    expect(store.getModelById("inserted-review")).toBeNull();
    expect(store.getModelById(untouched)?.text?.toString()).toBe(
      "Retain Anna's instruction",
    );
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test("Core replacement prepares target loads before deleting and fences every write", async () => {
  const { workspace, store, note } = fixture();
  const original = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Keep Anna's instruction") },
    note,
  );
  const target = workspace.createDoc("replacement-target");
  target.load();
  workspace.meta.setDocMeta(target.id, { title: "Target" });
  const targetStore = target.getStore();
  const root = targetStore.addBlock("myoxus:page", {
    title: new Text("Target"),
  });
  const targetNote = targetStore.addBlock("myoxus:note", {}, root);
  targetStore.addBlock(
    "myoxus:paragraph",
    { type: "h2", text: new Text("Review") },
    targetNote,
  );
  const readable = signal(true);
  let failLoad = true;
  let makeReadonly = false;
  let editOriginal = false;
  const access: DocEmbedProvider = {
    canRead: async () => true,
    readable: () => readable,
    waitForLoaded: async () => {
      if (failLoad) throw new Error("Target load failed");
      if (makeReadonly) store.readonly = true;
      if (editOriginal) {
        const text = store.getModelById(original)!.text!;
        text.insert(" (edited while loading)", text.length);
      }
    },
  };
  const std = new BlockStdScope({
    store,
    extensions: [
      ...workspace.storeExtensions,
      { setup: (di) => di.addImpl(DocEmbedProvider, access) },
    ],
  });
  const host = { store, std } as EditorHost;
  const source = "Follow [[Target#Review|review]].\n\nSecond instruction.";
  try {
    await expect(
      replaceFromMarkdown(host, source, store, note, 0, original),
    ).rejects.toThrow("Target load failed");
    expect(store.getModelById(original)?.text?.toString()).toBe(
      "Keep Anna's instruction",
    );
    failLoad = false;
    makeReadonly = true;
    await expect(
      replaceFromMarkdown(host, source, store, note, 0, original),
    ).rejects.toThrow("destination unavailable");
    expect(store.getModelById(original)?.text?.toString()).toBe(
      "Keep Anna's instruction",
    );
    store.readonly = false;
    makeReadonly = false;
    editOriginal = true;
    await expect(
      replaceFromMarkdown(host, source, store, note, 0, original),
    ).rejects.toThrow("replacement target changed");
    expect(store.getModelById(original)?.text?.toString()).toBe(
      "Keep Anna's instruction (edited while loading)",
    );
    editOriginal = false;
    const changed = store.slots.blockUpdated.subscribe((event) => {
      if (event.type === "add" && event.id === original) readable.value = false;
    });
    try {
      await expect(
        replaceFromMarkdown(host, source, store, note, 0, original),
      ).rejects.toThrow("access lost");
      // The first allowed mutation remains; later writes stop. This is not a
      // cross-document transaction or a promise of rollback after insertion.
      expect(store.getModelById(original)?.text?.toString()).toBe("Follow  .");
      expect(store.getModelById(note)?.children).toHaveLength(1);
    } finally {
      changed.unsubscribe();
    }
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test.each([PageClipboard, EdgelessClipboardController])(
  "AI text replacement uses $key native paste without flattening references or annotations",
  async (ClipboardOwner) => {
    const { workspace, store, note } = fixture();
    const paragraph = store.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("Prefix Draft suffix"),
      },
      note,
    );
    const std = new BlockStdScope({
      store,
      extensions: [
        ...workspace.storeExtensions,
        ...clipboardConfigs,
        ClipboardOwner,
        {
          setup: (di) =>
            di.addImpl(DocEmbedProvider, fixtureReferenceAccess(workspace)),
        },
      ],
    });
    // Happy DOM provides the host/view boundary; actual adapters, commands,
    // selection and Yjs models below are not mocked conversion results.
    const host = {
      std,
      store,
      selection: std.selection,
      updateComplete: Promise.resolve(),
      querySelector: () => null,
    } as unknown as EditorHost;
    vi.spyOn(std, "host", "get").mockReturnValue(host);
    const model = store.getModelById(paragraph)!;
    const parent = {
      model: store.getModelById(note),
      childBlocks: [{ blockId: paragraph }],
    } as unknown as BlockComponent;
    const first = { model, parentComponent: parent } as BlockComponent;
    vi.spyOn(std.view, "getBlock").mockImplementation((id) =>
      id === note ? parent : id === paragraph ? first : null,
    );
    const selection = std.selection.create(TextSelection, {
      from: { blockId: paragraph, index: 7, length: 5 },
      to: null,
    });
    std.selection.setGroup("note", [selection]);
    std.get(ClipboardOwner).mounted();
    try {
      await replaceEditorMarkdown(
        host,
        "## Release heading\n\nSee [[#Release heading|release]] and %%private [[literal]]%%.",
        first,
        [model],
        selection,
      );
      const models = store.getModelById(note)!.children;
      const heading = models.find(
        (block) => block.text?.toString() === "Release heading",
      );
      expect(heading).toBeDefined();
      expect(heading!.id).not.toBe(paragraph);
      expect(store.getModelById(paragraph)?.text?.toString()).toBe("Prefix ");
      const tail = models.at(-1)!;
      expect(tail.text?.toString()).toBe(
        "See   and private [[literal]]. suffix",
      );
      expect(
        tail.text
          ?.toDelta()
          .flatMap((delta) =>
            delta.attributes?.reference ? [delta.attributes.reference] : [],
          ),
      ).toMatchObject([
        {
          pageId: store.id,
          title: "release",
          params: { mode: "page", blockIds: [heading!.id] },
        },
      ]);
      expect(getAnnotationRanges(tail.text!.toDelta())).toHaveLength(1);
    } finally {
      std.unmount();
      workspace.dispose();
    }
  },
);

test.each(["file", "zip"] as const)(
  "general %s import prepares current guarded existing targets before document creation",
  async (kind) => {
    const { workspace, store } = fixture();
    const target = workspace.createDoc("opaque-file-target");
    target.load();
    workspace.meta.setDocMeta(target.id, { title: "Target" });
    const targetStore = target.getStore();
    const root = targetStore.addBlock("myoxus:page", {
      title: new Text("Target"),
    });
    const note = targetStore.addBlock("myoxus:note", {}, root);
    const heading = targetStore.addBlock(
      "myoxus:paragraph",
      {
        type: "h1",
        text: new Text("Old heading"),
      },
      note,
    );
    const paragraph = targetStore.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("Current target body"),
        markdownAnchor: "instruction",
      },
      note,
    );
    let readable = true;
    const normalAccess = fixtureReferenceAccess(workspace);
    const access: DocEmbedProvider = {
      ...normalAccess,
      canRead: async (id) =>
        (id !== target.id || readable) && normalAccess.canRead(id),
      waitForLoaded: vi.fn(async (id, signal) => {
        await normalAccess.waitForLoaded(id, signal);
        if (id === target.id) {
          targetStore.updateBlock(targetStore.getModelById(heading)!, {
            text: new Text("Über Größe"),
          });
          workspace.meta.setDocMeta(target.id, {
            title: "Current target title",
          });
        }
      }),
    };
    const base = `${window.location.origin}/workspace/${workspace.id}/${target.id}`;
    const source = `# Source\n\n[heading](${base}#%C3%9Cber%20Gr%C3%B6%C3%9Fe) [instruction](${base}#%5Einstruction) [native instruction](${base}?mode=page&blockIds=${paragraph})\n\nLocal decision. ^local\n\n[[#^local|local]]\n\n\`[[Target#^instruction]]\`\n\n%%[[Target#^instruction]]%%`;
    const run = async (capability: DocEmbedProvider | undefined = access) => {
      const options = {
        collection: workspace,
        schema: store.schema,
        extensions: workspace.storeExtensions,
        access: capability,
      };
      if (kind === "file") {
        const result = await MarkdownTransformer.importMarkdownToDoc({
          ...options,
          markdown: source,
          fileName: "Source",
        });
        return { diagnostics: result.diagnostics, docId: result.docId! };
      }
      const zip = new JSZip();
      zip.file("Source.md", source + "\n\n[[Second#Forward|forward]]");
      zip.file("Second.md", "# Second\n\n## Forward\n\nBatch target.");
      const result = await MarkdownTransformer.importMarkdownZip({
        ...options,
        imported: await zip.generateAsync({ type: "blob" }),
      });
      return {
        diagnostics: result.diagnostics,
        docId: result.docIds.find(
          (id) => workspace.meta.getDocMeta(id)?.title === "Source",
        )!,
      };
    };
    const references = (id: string) =>
      workspace
        .getDoc(id)!
        .getStore()
        .getBlocksByFlavour("myoxus:paragraph")
        .flatMap(({ model }) =>
          (model.text?.toDelta() ?? []).flatMap(({ attributes }) =>
            attributes?.reference ? [attributes.reference] : [],
          ),
        );
    try {
      const result = await run();
      expect(result.diagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      expect(
        references(result.docId)
          .slice(0, 2)
          .map(({ pageId, params }) => ({
            pageId,
            blockIds: params?.blockIds,
          })),
      ).toEqual([
        { pageId: target.id, blockIds: [heading] },
        { pageId: target.id, blockIds: [paragraph] },
      ]);
      const importedStore = workspace.getDoc(result.docId)!.getStore();
      const local = importedStore
        .getBlocksByFlavour("myoxus:paragraph")
        .map(({ model }) => model as ParagraphBlockModel)
        .find((model) => model.props.markdownAnchor === "local")!;
      expect(
        references(result.docId).find(({ title }) => title === "local"),
      ).toMatchObject({
        pageId: result.docId,
        params: { blockIds: [local.id] },
      });
      expect(
        references(result.docId).find(
          ({ title }) => title === "native instruction",
        ),
      ).toMatchObject({ pageId: target.id, params: { blockIds: [paragraph] } });
      if (kind === "zip") {
        const forward = references(result.docId).find(
          ({ title }) => title === "forward",
        )!;
        expect(forward.pageId).not.toBe(result.docId);
        expect(
          workspace
            .getDoc(forward.pageId)!
            .getStore()
            .getModelById<ParagraphBlockModel>(forward.params!.blockIds![0])!
            .props.text.toString(),
        ).toBe("Forward");
      }
      readable = false;
      workspace.meta.setDocMeta(target.id, { title: "CACHED PRIVATE TITLE" });
      vi.mocked(access.waitForLoaded).mockClear();
      const denied = await run();
      expect(denied.diagnostics.unresolvedReferences).toBe(3);
      expect(
        references(denied.docId).some(({ pageId }) => pageId === target.id),
      ).toBe(false);
      expect(access.waitForLoaded).not.toHaveBeenCalledWith(
        target.id,
        expect.anything(),
      );
      expect(
        workspace
          .getDoc(denied.docId)!
          .getStore()
          .getModelsByFlavour("myoxus:paragraph")
          .map((model) => model.text?.toString())
          .join(" "),
      ).not.toContain("CACHED PRIVATE TITLE");
      readable = true;
      targetStore.deleteBlock(targetStore.getModelById(paragraph)!);
      const deleted = await run();
      expect(deleted.diagnostics.unresolvedReferences).toBe(2);
      expect(
        references(deleted.docId).some(({ params }) =>
          params?.blockIds?.includes(paragraph),
        ),
      ).toBe(false);
      const before = workspace.meta.docMetas.map(({ id }) => id);
      await expect(
        run({
          ...access,
          waitForLoaded: async () => {
            throw new Error("Target load failed");
          },
        }),
      ).rejects.toThrow("Target load failed");
      expect(workspace.meta.docMetas.map(({ id }) => id)).toEqual(before);
      let revoked = false;
      await expect(
        run({
          ...access,
          canRead: async (id) => {
            if (id === target.id && revoked) return false;
            return normalAccess.canRead(id);
          },
          readable: (id) =>
            signal(
              !(id === target.id && revoked) &&
                normalAccess.readable(id).value === true,
            ),
          // Revocation belongs to the load boundary, not an arbitrary number
          // of repeated network checks in the old implementation.
          waitForLoaded: async (id, signal) => {
            await access.waitForLoaded(id, signal);
            if (id === target.id) revoked = true;
          },
        }),
      ).rejects.toThrow("Markdown import reference access lost");
      expect(workspace.meta.docMetas.map(({ id }) => id)).toEqual(before);
    } finally {
      workspace.dispose();
    }
  },
);

test.each([false, true])(
  "both actual Markdown downloads retain current native targets, export-only anchors and read fences (mounted=%s)",
  async (mounted) => {
    const { workspace, store, note } = fixture();
    const std = mounted
      ? new BlockStdScope({ store, extensions: workspace.storeExtensions })
      : undefined;
    const target = workspace.createDoc("opaque-export-target");
    target.load();
    workspace.meta.setDocMeta(target.id, { title: "Target" });
    workspace.meta.setDocMeta(store.id, { title: "Current source" });
    const targetStore = target.getStore();
    const targetRoot = targetStore.addBlock("myoxus:page", {
      title: new Text("Target"),
    });
    const targetNote = targetStore.addBlock("myoxus:note", {}, targetRoot);
    const targetParagraph = targetStore.addBlock(
      "myoxus:paragraph",
      { text: new Text("Target body must not be expanded") },
      targetNote,
    );
    const targetCode = targetStore.addBlock(
      "myoxus:code",
      { text: new Text("Literal protected target") },
      targetNote,
    );
    const generated = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Current decision") },
      note,
    );
    const retained = store.addBlock(
      "myoxus:paragraph",
      { text: new Text("Local decision"), markdownAnchor: "local" },
      note,
    );
    const ref = (
      pageId: string,
      blockId: string,
      title: string,
    ): MyoxusTextAttributes => ({
      reference: {
        type: "LinkedPage",
        pageId,
        title,
        params: { mode: "page", blockIds: [blockId], elementIds: undefined },
      },
    });
    store.addBlock(
      "myoxus:paragraph",
      {
        text: new Text<MyoxusTextAttributes>([
          { insert: " ", attributes: ref(store.id, generated, "new decision") },
          { insert: " and " },
          {
            insert: " ",
            attributes: ref(store.id, retained, "local decision"),
          },
          { insert: " then " },
          {
            insert: " ",
            attributes: ref(target.id, targetParagraph, "target decision"),
          },
          { insert: " and " },
          {
            insert: " ",
            attributes: ref(target.id, targetCode, "literal code"),
          },
        ]),
      },
      note,
    );
    store.addBlock(
      "myoxus:table",
      {
        rows: { r: { rowId: "r", order: "a0" } },
        columns: { c: { columnId: "c", order: "a0" } },
        cells: {
          "r:c": {
            text: new Text<MyoxusTextAttributes>([
              {
                insert: " ",
                attributes: ref(store.id, generated, "table decision"),
              },
            ]),
          },
        },
      },
      note,
    );
    const literal = "Literal [[Target#^protected]] stays untouched";
    store.addBlock("myoxus:code", { text: new Text(literal) }, note);
    store.addBlock("myoxus:annotation", { text: new Text(literal) }, note);
    const denied = new Set<string>();
    const normalAccess = fixtureReferenceAccess(workspace);
    const access: DocEmbedProvider = {
      ...normalAccess,
      canRead: async (id) => !denied.has(id) && normalAccess.canRead(id),
      waitForLoaded: vi.fn(normalAccess.waitForLoaded),
    };
    const files: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      files.push(blob as Blob);
      return "blob:native-export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const diagnostics = await exportActions.exportToMarkdown(
        store,
        std,
        access,
      );
      expect(diagnostics).toEqual({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      expect(files).toHaveLength(1);
      const markdown = await files.pop()!.text();
      const anchor = markdown.match(/\^(myoxus-[a-f0-9]{64})/u)?.[1];
      expect(anchor).toMatch(/^myoxus-[a-f0-9]{64}$/u);
      expect(markdown).toContain(`#\\%5E${anchor}`);
      expect(markdown).toContain("#\\%5Elocal");
      expect(markdown).toContain(`blockIds=${targetParagraph}`);
      expect(markdown).toContain(`blockIds=${targetCode}`);
      expect(markdown).not.toContain("Target body must not be expanded");
      expect(markdown).toContain(literal);
      expect(
        store.getModelById<ParagraphBlockModel>(generated)!.props
          .markdownAnchor,
      ).toBeUndefined();
      const imported = await MarkdownTransformer.importMarkdownToDoc({
        collection: workspace,
        schema: store.schema,
        markdown,
        extensions: workspace.storeExtensions,
        access,
      });
      expect(imported.docId).toBeTypeOf("string");
      const reimported = workspace.getDoc(imported.docId!)!.getStore();
      const newTarget = reimported
        .getBlocksByFlavour("myoxus:paragraph")
        .map(({ model }) => model as ParagraphBlockModel)
        .find((model) => model.props.markdownAnchor === anchor)!;
      expect(newTarget.id).not.toBe(generated);
      const refs = Object.values(reimported.blocks.peek())
        .flatMap(({ model }) => [
          ...(model.text?.toDelta() ?? []),
          ...Object.values(
            (model.flavour === "myoxus:table"
              ? (model as TableBlockModel).props.cells
              : {}) as Record<string, { text: Text<MyoxusTextAttributes> }>,
          ).flatMap((cell) => cell.text.toDelta()),
        ])
        .flatMap((delta) =>
          delta.attributes?.reference ? [delta.attributes.reference] : [],
        );
      expect(
        refs
          .filter(
            (reference) =>
              reference.title === "new decision" ||
              reference.title === "table decision",
          )
          .map((reference) => ({
            pageId: reference.pageId,
            blockIds: reference.params?.blockIds,
          })),
      ).toEqual([
        { pageId: reimported.id, blockIds: [newTarget.id] },
        { pageId: reimported.id, blockIds: [newTarget.id] },
      ]);
      expect(
        refs.find((reference) => reference.title === "target decision")?.params
          ?.blockIds,
      ).toEqual([targetParagraph]);
      denied.add(target.id);
      workspace.meta.setDocMeta(target.id, { title: "CACHED PRIVATE TITLE" });
      vi.mocked(access.waitForLoaded).mockClear();
      const hidden = await exportActions.exportToMarkdown(store, std, access);
      expect(hidden?.unresolvedReferences).toBe(2);
      const hiddenMarkdown = await files.pop()!.text();
      expect(hiddenMarkdown).not.toContain("CACHED PRIVATE TITLE");
      expect(hiddenMarkdown).not.toContain("Target body must not be expanded");
      expect(hiddenMarkdown).not.toContain(targetParagraph);
      expect(access.waitForLoaded).not.toHaveBeenCalledWith(
        target.id,
        expect.anything(),
      );
      denied.clear();
      targetStore.deleteBlock(targetStore.getModelById(targetParagraph)!);
      const deleted = await exportActions.exportToMarkdown(store, std, access);
      expect(deleted?.unresolvedReferences).toBe(1);
      expect(await files.pop()!.text()).not.toContain(targetParagraph);
      workspace.removeDoc(target.id);
      const removed = await exportActions.exportToMarkdown(store, std, access);
      expect(removed?.unresolvedReferences).toBe(2);
      expect(await files.pop()!.text()).not.toContain("opaque-export-target");
      const assetId = await workspace.blobSync.set(
        new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], {
          type: "image/svg+xml",
        }),
      );
      store.addBlock("myoxus:image", { sourceId: assetId }, note);
      const get = workspace.blobSync.get.bind(workspace.blobSync);
      vi.spyOn(workspace.blobSync, "get").mockImplementation(async (id) => {
        const blob = await get(id);
        denied.add(store.id);
        return blob;
      });
      await expect(
        exportActions.exportToMarkdown(store, std, access),
      ).rejects.toThrow("Markdown export access lost");
      expect(files).toHaveLength(0);
    } finally {
      std?.unmount();
      workspace.dispose();
    }
  },
);

function mathSources(nodes: BlockSnapshot[]) {
  const inline: string[] = [];
  const display: string[] = [];
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const delta = (value as SnapshotText).delta;
    if (Array.isArray(delta)) {
      for (const part of delta)
        if (typeof part.attributes?.latex === "string") {
          expect(part.insert).toBe(" ");
          inline.push(part.attributes.latex);
        }
    } else Object.values(value).forEach(inspect);
  };
  const visit = (node: BlockSnapshot) => {
    if (node.flavour === "myoxus:latex") display.push(String(node.props.latex));
    Object.values(node.props).forEach(inspect);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return { inline: inline.sort(), display: display.sort() };
}

function codeSources(nodes: BlockSnapshot[]): string[] {
  return nodes
    .flatMap((node) => [
      ...(node.flavour === "myoxus:code"
        ? [
            (node.props.text as SnapshotText).delta
              .map((part) => part.insert)
              .join(""),
          ]
        : []),
      ...codeSources(node.children),
    ])
    .sort();
}

test.each(
  mathFixtures.filter(
    ({ name }) => name !== "paragraph formula" && name !== "display formula",
  ),
)("registered Core math import/export preserves $name", async (entry) => {
  const { workspace, store } = fixture();
  const job = store.getTransformer();
  const prepared = await markdownToSnapshot(entry.source, store);
  try {
    const { snapshot, diagnostics } = prepared;
    const nodes = snapshot!.content[0].children;
    const expected = {
      inline: [...entry.inline].sort(),
      display: [...entry.display].sort(),
    };
    expect(mathSources(nodes), JSON.stringify(nodes)).toEqual(expected);
    expect(diagnostics.unsupportedMath ?? 0).toBe(entry.unsupported);
    if (entry.name === "literal annotations") {
      const paragraph = nodes.find(
        (node) => node.flavour === "myoxus:paragraph",
      )!;
      expect(
        getAnnotationRanges((paragraph.props.text as SnapshotText).delta).map(
          (range) => range.body,
        ),
      ).toEqual(["$x$ $$y$$ \\ce{H2O} and \\(literal\\)"]);
      const block = nodes.find((node) => node.flavour === "myoxus:annotation")!;
      expect(
        (block.props.text as SnapshotText).delta
          .map((part) => part.insert)
          .join(""),
      ).toBe("$$z$$ and \\[literal display\\]");
    }
    const adapter = new MarkdownAdapter(job, store.provider);
    const slice = {
      type: "slice" as const,
      content: nodes,
      workspaceId: workspace.id,
      pageId: store.id,
    };
    const markdown = await adapter.fromSliceSnapshot({ snapshot: slice });
    const reimported = await adapter.toBlockSnapshot({ file: markdown.file });
    expect(mathSources(reimported.children)).toEqual(expected);
    for (const formula of [...expected.inline, ...expected.display])
      expect(markdown.file).toContain(formula);
    const html = await new HtmlAdapter(job, store.provider).fromSliceSnapshot({
      snapshot: slice,
    });
    const readback = await new HtmlAdapter(job, store.provider).toBlockSnapshot(
      { file: html.file },
    );
    expect(mathSources(readback.children)).toEqual(expected);
    // Counting native formulas alone misses a competing generic <pre>
    // matcher inserting duplicate formula source as a second code block.
    expect(codeSources(readback.children)).toEqual(codeSources(nodes));
    const plain = await new PlainTextAdapter(
      job,
      store.provider,
    ).fromSliceSnapshot({ snapshot: slice });
    for (const formula of [...expected.inline, ...expected.display]) {
      expect(plain.file).toContain(formula);
      const view = document.createElement("div");
      view.innerHTML = html.file;
      expect(view.textContent).toContain(formula);
    }
  } finally {
    job[Symbol.dispose]();
    prepared.transformer[Symbol.dispose]();
    workspace.dispose();
  }
});

test.each(
  [true].flatMap((mounted) =>
    [
      "allowed",
      "denied",
      "revoked",
      "nested-denied",
      "missing",
      "asset-revoked",
    ].map((access) => ({ mounted, access })),
  ),
)(
  "HTML export checks current content and access: $access, editor mounted=$mounted",
  async ({ access, mounted }) => {
    const { workspace, store, note } = fixture();
    try {
      const target = workspace.createDoc("cached-html-target");
      target.load();
      const targetStore = target.getStore();
      const root = targetStore.addBlock("myoxus:page", {
        title: new Text("Approval"),
      });
      const targetNote = targetStore.addBlock("myoxus:note", {}, root);
      const targetParagraph = targetStore.addBlock(
        "myoxus:paragraph",
        { text: new Text("Stale cached approval") },
        targetNote,
      );
      targetStore.addBlock(
        "myoxus:annotation",
        { text: new Text("Hidden target annotation") },
        targetNote,
      );
      store.addBlock("myoxus:embed-synced-doc", { pageId: target.id }, note);
      store.addBlock(
        "myoxus:callout",
        {
          type: "note",
          title: new Text("Visible checklist"),
          text: new Text("Visible note body"),
        },
        note,
      );
      store.addBlock(
        "myoxus:annotation",
        { text: new Text("Hidden source annotation") },
        note,
      );
      store.addBlock(
        "myoxus:paragraph",
        {
          text: new Text<MyoxusTextAttributes>([
            { insert: "Before " },
            {
              insert: "Hidden inline annotation",
              attributes: { annotation: { id: "html-inline" } },
            },
            { insert: " after" },
          ]),
        },
        note,
      );
      if (access === "allowed" || access === "nested-denied") {
        const nested = workspace.createDoc("denied-nested-target");
        nested.load();
        nested
          .getStore()
          .addBlock("myoxus:page", { title: new Text("Private nested title") });
        workspace.meta.setDocMeta(nested.id, { title: "Nested approval" });
        const nestedStore = nested.getStore();
        const nestedNote = nestedStore.addBlock(
          "myoxus:note",
          {},
          nestedStore.root!.id,
        );
        nestedStore.addBlock(
          "myoxus:paragraph",
          { text: new Text("Nested private body") },
          nestedNote,
        );
        nestedStore.addBlock(
          "myoxus:embed-synced-doc",
          { pageId: "unloaded-third-level" },
          nestedNote,
        );
        targetStore.addBlock(
          "myoxus:embed-synced-doc",
          { pageId: nested.id },
          targetNote,
        );
      }
      const permission = signal(access !== "denied");
      const nestedPermission = signal(access === "allowed");
      const embedProvider: DocEmbedProvider = {
        canRead: async (id) => embedProvider.readable(id).value === true,
        readable: (id) =>
          id === store.id
            ? signal(true)
            : id === target.id
              ? permission
              : nestedPermission,
        waitForLoaded: vi.fn(async (id) => {
          if (id === target.id && access === "revoked")
            permission.value = false;
          if (!embedProvider.readable(id).value)
            throw new Error("Document embed access denied");
          if (id === target.id && access === "missing") {
            workspace.removeDoc(target.id);
            return;
          }
          if (id === target.id)
            targetStore.updateBlock(
              targetStore.getBlock(targetParagraph)!.model,
              {
                text: new Text("Current target approval"),
              },
            );
        }),
      };
      if (access === "asset-revoked") {
        const assetId = await workspace.blobSync.set(
          new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], {
            type: "image/svg+xml",
          }),
        );
        store.addBlock("myoxus:image", { sourceId: assetId }, note);
        const get = workspace.blobSync.get.bind(workspace.blobSync);
        vi.spyOn(workspace.blobSync, "get").mockImplementation(async (id) => {
          const blob = await get(id);
          permission.value = false;
          return blob;
        });
      }
      const std = mounted
        ? new BlockStdScope({
            store,
            extensions: [
              ...workspace.storeExtensions,
              {
                setup: (di) => {
                  di.addImpl(DocEmbedProvider, embedProvider);
                },
              },
            ],
          })
        : undefined;
      const files: Blob[] = [];
      vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        files.push(blob as Blob);
        return "blob:html-interchange";
      });
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        () => {},
      );
      if (access === "allowed") {
        await exportActions.exportToHtml(store, std, embedProvider);
        expect(files).toHaveLength(1);
        const html = await files[0].text();
        expect(html).toContain("Current target approval");
        expect(html).not.toContain("Stale cached approval");
        expect(html).toContain("Nested approval");
        expect(html).not.toContain("Nested private body");
        expect(html).toContain("Visible checklist");
        expect(html).toContain("Visible note body");
        expect(html).not.toContain("Hidden target annotation");
        expect(html).not.toContain("Hidden source annotation");
        expect(html).not.toContain("Hidden inline annotation");
        expect(html).not.toContain("![[");
        if (mounted) {
          await exportActions.exportToHtml(store, undefined, embedProvider);
          expect(files).toHaveLength(2);
          const parser = new DOMParser();
          expect(
            parser.parseFromString(await files[1].text(), "text/html").body
              .innerHTML,
          ).toBe(parser.parseFromString(html, "text/html").body.innerHTML);
        }
      } else {
        await expect(
          exportActions.exportToHtml(store, std, embedProvider),
        ).rejects.toThrow(
          access === "missing" ? "target missing" : "access denied",
        );
        expect(files).toEqual([]);
      }
      expect(embedProvider.waitForLoaded).toHaveBeenCalledWith(
        target.id,
        expect.any(AbortSignal),
      );
    } finally {
      workspace.dispose();
    }
  },
);

test("editor-free HTML cannot fall back to cached reference export without Core access", async () => {
  const { workspace, store, note } = fixture();
  try {
    store.addBlock(
      "myoxus:embed-synced-doc",
      { pageId: "cached-html-target" },
      note,
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await expect(exportActions.exportToHtml(store)).rejects.toThrow(
      "access unavailable",
    );
    expect(click).not.toHaveBeenCalled();
  } finally {
    workspace.dispose();
  }
});

test("actual Core snapshot preparation uses registered annotations without creating another destination document", async () => {
  const { workspace, store } = fixture();
  try {
    const ids = workspace.meta.docMetas.map((meta) => meta.id);
    const { snapshot, diagnostics } = await markdownToSnapshot(
      "Before %%literal\nbody%% after\n\n%%sticky%%",
      store,
    );
    expect(workspace.meta.docMetas.map((meta) => meta.id)).toEqual(ids);
    expect(diagnostics).toEqual({
      unresolvedReferences: 0,
      unsupportedReferences: 0,
    });
    const children = snapshot!.content[0].children;
    expect(children.map((child) => child.flavour)).toEqual([
      "myoxus:paragraph",
      "myoxus:annotation",
    ]);
    expect(
      getAnnotationRanges((children[0].props.text as SnapshotText).delta).map(
        (range) => range.body,
      ),
    ).toEqual(["literal\nbody"]);
    expect((children[1].props.text as SnapshotText).delta).toEqual([
      { insert: "sticky" },
    ]);
  } finally {
    workspace.dispose();
  }
});

test("actual no-host Markdown conversion materializes native content through the Core store provider", async () => {
  const store = await markDownToDoc(
    "Before %%literal **body**%% after\n\n%%sticky%%",
  );
  try {
    expect(
      store.getBlocksByFlavour("myoxus:annotation")[0].model.text!.toString(),
    ).toBe("sticky");
    const paragraph = store.getBlocksByFlavour("myoxus:paragraph")[0].model;
    expect(
      getAnnotationRanges(paragraph.text!.toDelta()).map((range) => range.body),
    ).toEqual(["literal **body**"]);
  } finally {
    store.workspace.removeDoc(store.id);
    store.dispose();
  }
});

test("actual file, block and general ZIP consumers preserve literal YAML-looking annotation bodies", async () => {
  const { workspace, store, note } = fixture();
  try {
    const body = "first\n---\ntitle: not metadata\n---\nlast";
    const markdown = `Before\n\n%%${body}%%`;
    const extensions = workspace.storeExtensions;
    const imported = await MarkdownTransformer.importMarkdownToDoc({
      collection: workspace,
      schema: store.schema,
      extensions,
      markdown,
      fileName: "Actual file",
    });
    expect(
      (
        workspace.getDoc(imported.docId!)!.getStore().root as RootBlockModel
      ).props.title.toString(),
    ).toBe("Actual file");
    expect(
      workspace
        .getDoc(imported.docId!)!
        .getStore()
        .getBlocksByFlavour("myoxus:annotation")[0]
        .model.text!.toString(),
    ).toBe(body);
    await MarkdownTransformer.importMarkdownToBlock({
      doc: store,
      blockId: note,
      extensions,
      markdown,
    });
    expect(
      store.getBlocksByFlavour("myoxus:annotation")[0].model.text!.toString(),
    ).toBe(body);
    const zip = new JSZip();
    zip.file("nested/Actual archive.md", markdown);
    const archive = await MarkdownTransformer.importMarkdownZip({
      collection: workspace,
      schema: store.schema,
      extensions,
      imported: new Blob([await zip.generateAsync({ type: "arraybuffer" })]),
    });
    expect(archive.docIds).toHaveLength(1);
    expect(
      workspace
        .getDoc(archive.docIds[0])!
        .getStore()
        .getBlocksByFlavour("myoxus:annotation")[0]
        .model.text!.toString(),
    ).toBe(body);
    expect(archive.diagnostics).toEqual({
      unresolvedReferences: 0,
      unsupportedReferences: 0,
    });
  } finally {
    workspace.dispose();
  }
});

test("actual selection Markdown export expands a partial marker and retains every Yjs delta and line", async () => {
  const { workspace, store, note } = fixture();
  try {
    const id = store.addBlock(
      "myoxus:paragraph",
      {
        text: new Text([
          { insert: "Before " },
          { insert: "first\n", attributes: { annotation: { id: "a" } } },
          {
            insert: "second",
            attributes: { annotation: { id: "a" }, bold: true },
          },
          { insert: " after" },
        ]),
      },
      note,
    );
    const std = new BlockStdScope({
      store,
      extensions: [
        ...workspace.storeExtensions,
        {
          setup: (di) =>
            di.addImpl(DocEmbedProvider, fixtureReferenceAccess(workspace)),
        },
      ],
    });
    std.selection.setGroup("note", [
      new TextSelection({
        from: { blockId: id, index: 9, length: 1 },
        to: null,
      }),
    ]);
    const host = { std, store, selection: std.selection } as EditorHost;
    const source = await getContentFromSlice(
      host,
      Slice.fromModels(store, [store.getModelById(id)!]),
    );
    const job = store.getTransformer();
    try {
      const imported = await new MarkdownAdapter(
        job,
        store.provider,
      ).toBlockSnapshot({ file: source });
      expect(imported.children[0].flavour).toBe("myoxus:annotation");
      expect((imported.children[0].props.text as SnapshotText).delta).toEqual([
        { insert: "first\nsecond" },
      ]);
      expect(source).not.toContain("Before");
      expect(source).not.toContain("after");
    } finally {
      job[Symbol.dispose]();
    }
  } finally {
    workspace.dispose();
  }
});

test.each([false, true])(
  "actual Markdown export action preserves edited native bodies (mounted=%s)",
  async (mounted) => {
    const { workspace, store, note } = fixture();
    try {
      const id = store.addBlock(
        "myoxus:annotation",
        { text: new Text("old imported body") },
        note,
      );
      store
        .getModelById(id)!
        .text!.replace(0, "old imported body".length, "current\nliteral %% ✓");
      store.addBlock(
        "myoxus:callout",
        {
          type: "note",
          title: new Text("Current approval"),
          text: new Text([
            { insert: "Current body", attributes: { bold: true } },
          ]),
        },
        note,
      );
      const target = workspace.createDoc("approval-target");
      target.load();
      workspace.meta.setDocMeta(target.id, { title: "Approval target" });
      const targetRoot = target.getStore().addBlock("myoxus:page", {
        title: new Text("Approval target"),
      });
      const targetNote = target
        .getStore()
        .addBlock("myoxus:note", {}, targetRoot);
      target.getStore().addBlock(
        "myoxus:paragraph",
        {
          text: new Text("Private target body must not replace the reference"),
        },
        targetNote,
      );
      store.addBlock(
        "myoxus:embed-synced-doc",
        {
          pageId: target.id,
          title: "Current approval",
        },
        note,
      );
      store.addBlock(
        "myoxus:paragraph",
        {
          text: new Text<MyoxusTextAttributes>([
            {
              insert: " ",
              attributes: {
                reference: {
                  type: "LinkedPage",
                  pageId: target.id,
                  title: "Open approval",
                },
              },
            },
          ]),
        },
        note,
      );
      const files: Blob[] = [];
      vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        files.push(blob as Blob);
        return "blob:annotation-interchange";
      });
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        () => {},
      );
      const std = mounted
        ? new BlockStdScope({ store, extensions: workspace.storeExtensions })
        : undefined;
      const diagnostics = await exportActions.exportToMarkdown(
        store,
        std,
        fixtureReferenceAccess(workspace),
      );
      expect(diagnostics?.unsupportedAnnotations ?? 0).toBe(0);
      expect(files).toHaveLength(1);
      const source = await files[0].text();
      expect(source).not.toContain("Private target body");
      const job = store.getTransformer([
        docLinkBaseURLMiddleware(workspace.id),
        documentReferenceMiddleware(workspace.meta.docMetas),
      ]);
      try {
        const snapshot = await new MarkdownAdapter(
          job,
          store.provider,
        ).toBlockSnapshot({ file: source });
        const annotation = snapshot.children.find(
          (child) => child.flavour === "myoxus:annotation",
        )!;
        expect((annotation.props.text as SnapshotText).delta).toEqual([
          { insert: "current\nliteral %% ✓" },
        ]);
        expect(source).not.toContain("old imported body");
        const callout = snapshot.children.find(
          (child) => child.flavour === "myoxus:callout",
        )!;
        expect(callout.props.type).toBe("note");
        expect((callout.props.title as SnapshotText).delta).toEqual([
          { insert: "Current approval" },
        ]);
        expect((callout.props.text as SnapshotText).delta).toEqual([
          { insert: "Current body", attributes: { bold: true } },
        ]);
        const embed = snapshot.children.find(
          (child) => child.flavour === "myoxus:embed-synced-doc",
        )!;
        expect(embed, source).toBeDefined();
        expect(embed.props).toMatchObject({
          pageId: target.id,
          title: "Current approval",
        });
        expect(embed.children).toEqual([]);
        const reference = snapshot.children
          .filter((child) => child.flavour === "myoxus:paragraph")
          .flatMap((child) => (child.props.text as SnapshotText).delta)
          .find((delta) => delta.attributes?.reference)?.attributes?.reference;
        expect(reference).toMatchObject({
          type: "LinkedPage",
          pageId: target.id,
        });
      } finally {
        job[Symbol.dispose]();
      }
    } finally {
      workspace.dispose();
    }
  },
);

const localFootnoteSource =
  "Read[^Study] twice[^STUDY], other[^Study-2].\n\n[^Study]: First body.\n\n    Second paragraph.\n\n    3. Ordered body\n\n[^Study-2]: Other body.";

function footnoteClipboardScope(
  store: ReturnType<typeof fixture>["store"],
  notifyMarkdownImportDiagnostics = vi.fn(),
) {
  const std = new BlockStdScope({
    store,
    extensions: [
      ...(store.workspace as TestWorkspace).storeExtensions,
      NotificationExtension({
        notifyMarkdownImportDiagnostics,
        toast: vi.fn(),
        confirm: vi.fn(async () => false),
        prompt: vi.fn(async () => null),
        notify: vi.fn(),
        notifyWithUndoAction: vi.fn(),
      }),
      ClipboardAdapterConfigExtension({
        mimeType: ClipboardAdapter.MIME,
        adapter: ClipboardAdapter,
        priority: 100,
      }),
      ClipboardAdapterConfigExtension({
        mimeType: "text/plain",
        adapter: MixTextAdapter,
        priority: 70,
      }),
      {
        setup: (di) =>
          di.addImpl(
            DocEmbedProvider,
            fixtureReferenceAccess(store.workspace as TestWorkspace),
          ),
      },
    ],
  });
  vi.spyOn(std, "host", "get").mockReturnValue({
    updateComplete: Promise.resolve(),
    querySelector: () => null,
  } as unknown as EditorHost);
  std.clipboard.use(pasteMiddleware(std));
  std.clipboard.use(documentReferenceMiddleware([]));
  std.clipboard.use(replaceIdMiddleware(store.workspace.idGenerator));
  return std;
}

const footnoteEvent = (native: unknown) =>
  ({
    clipboardData: {
      types: [ClipboardAdapter.MIME, "text/plain"],
      files: [],
      getData: (type: string) =>
        type === ClipboardAdapter.MIME
          ? JSON.stringify({ snapshot: native, blobs: {} })
          : "Fallback must not be inserted",
    },
  }) as unknown as ClipboardEvent;

test("Core footnote copy completes bodies, remaps shared targets, retains neighbors and restores exact IDs through history", async () => {
  const { workspace, store, note } = fixture();
  const other = workspace.createDoc("footnote-copy-source");
  other.load();
  const source = other.getStore();
  const root = source.addBlock("myoxus:page");
  const sourceNote = source.addBlock("myoxus:note", {}, root);
  await insertFromMarkdown(undefined, localFootnoteSource, source, sourceNote);
  const existing = store.addBlock(
    "myoxus:footnote-definition",
    { label: "Study" },
    note,
  );
  store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Existing body.") },
    existing,
  );
  const destination = store.addBlock(
    "myoxus:paragraph",
    { text: new Text("Before after") },
    note,
  );
  const std = footnoteClipboardScope(store);
  using job = source.getTransformer();
  const paragraph = source
    .getBlocksByFlavour("myoxus:paragraph")
    .find(({ model }) => model.text?.toString().startsWith("Read"))!.model;
  const snapshot = job.sliceToSnapshot(Slice.fromModels(source, [paragraph]))!;
  const create = vi.spyOn(workspace, "createDoc");
  const remove = vi.spyOn(workspace, "removeDoc");
  store.resetHistory();
  store.captureSync();
  const originalIds = store
    .getBlocksByFlavour("myoxus:footnote-definition")
    .map(({ model }) => model.id);
  std.selection.setGroup("note", [
    new TextSelection({
      from: { blockId: destination, index: 7, length: 0 },
      to: null,
    }),
  ]);
  try {
    expect(
      snapshot.content.filter(
        (b) => b.flavour === "myoxus:footnote-definition",
      ),
    ).toHaveLength(2);
    await std.clipboard.paste(footnoteEvent(snapshot), store, note);
    store.captureSync();
    const definitions = store
      .getBlocksByFlavour("myoxus:footnote-definition")
      .map(({ model }) => model as FootnoteDefinitionBlockModel);
    const cloned = definitions.find((d) => d.props.label === "Study-3")!;
    const second = definitions.find((d) => d.props.label === "Study-2")!;
    expect(cloned.children.map((c) => c.text?.toString())).toEqual([
      "First body.",
      "Second paragraph.",
      "Ordered body",
    ]);
    expect((cloned.children[2] as ListBlockModel).props.order).toBe(3);
    const deltas = store.getModelById(destination)!.text!.toDelta();
    expect(deltas.map((d) => d.insert).join("")).toBe(
      "Before Read  twice , other .after",
    );
    const markers = deltas.flatMap((d) =>
      d.attributes?.footnote ? [d.attributes.footnote] : [],
    );
    expect(markers).toEqual([
      { label: "Study-3", definitionId: cloned.id },
      { label: "Study-3", definitionId: cloned.id },
      { label: "Study-2", definitionId: second.id },
    ]);
    expect(cloned.id).not.toBe(
      source.getBlocksByFlavour("myoxus:footnote-definition")[0].model.id,
    );
    const finalIds = definitions.map((d) => d.id);
    store.undo();
    expect(
      store
        .getBlocksByFlavour("myoxus:footnote-definition")
        .map(({ model }) => model.id),
    ).toEqual(originalIds);
    expect(store.getModelById(destination)!.text!.toString()).toBe(
      "Before after",
    );
    store.redo();
    expect(
      store
        .getBlocksByFlavour("myoxus:footnote-definition")
        .map(({ model }) => model.id),
    ).toEqual(finalIds);
    expect(workspace.meta.docMetas).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test.each(["readonly", "nested", "unresolved", "invalid citation"])(
  "Core footnote %s denial precedes selection changes and cannot flatten through MIME fallback",
  async (reason) => {
    const { workspace, store, note } = fixture();
    await insertFromMarkdown(undefined, localFootnoteSource, store, note);
    const std = footnoteClipboardScope(store);
    using job = store.getTransformer();
    const paragraph = store
      .getBlocksByFlavour("myoxus:paragraph")
      .find(({ model }) => model.text?.toString().startsWith("Read"))!.model;
    const snapshot = job.sliceToSnapshot(Slice.fromModels(store, [paragraph]))!;
    const nested = store.getBlocksByFlavour("myoxus:footnote-definition")[0]
      .model.children[0];
    const before = job.docToSnapshot(store)!;
    const beforeInsert = vi.fn();
    if (reason === "readonly") store.readonly = true;
    if (reason === "nested")
      std.selection.setGroup("note", [
        new TextSelection({
          from: { blockId: nested.id, index: 0, length: 0 },
          to: null,
        }),
      ]);
    if (reason === "unresolved" || reason === "invalid citation") {
      const delta = (snapshot.content[0].props.text as SnapshotText).delta.find(
        (d) => d.attributes?.footnote,
      )!;
      delta.attributes!.footnote =
        reason === "unresolved"
          ? { label: "Study", definitionId: "missing" }
          : { label: "Study", reference: { type: "url", url: "" } };
    }
    try {
      await expect(
        std.clipboard.paste(
          footnoteEvent(snapshot),
          store,
          note,
          undefined,
          beforeInsert,
        ),
      ).rejects.toThrow(
        reason === "readonly"
          ? "read-only"
          : reason === "nested"
            ? "Nested footnote"
            : reason === "unresolved"
              ? "Unresolved footnote definition: Study"
              : "citation target: Study",
      );
      expect(beforeInsert).not.toHaveBeenCalled();
      expect(job.docToSnapshot(store)!.blocks).toEqual(before.blocks);
      expect(workspace.meta.docMetas).toHaveLength(1);
    } finally {
      store.readonly = false;
      std.unmount();
      workspace.dispose();
    }
  },
);

test("Core selection Markdown keeps a referenced footnote complete when the endpoint is in its normal body", async () => {
  const { workspace, store, note } = fixture();
  await insertFromMarkdown(undefined, localFootnoteSource, store, note);
  const std = footnoteClipboardScope(store);
  const paragraph = store
    .getBlocksByFlavour("myoxus:paragraph")
    .find(({ model }) => model.text?.toString().startsWith("Read"))!.model;
  const body = store.getBlocksByFlavour("myoxus:footnote-definition")[0].model
    .children[0];
  std.selection.setGroup("note", [
    new TextSelection({
      from: { blockId: paragraph.id, index: 0, length: paragraph.text!.length },
      to: { blockId: body.id, index: 0, length: 3 },
    }),
  ]);
  try {
    const markdown = await getContentFromSlice(
      { std, store, selection: std.selection } as EditorHost,
      Slice.fromModels(store, [paragraph, body]),
    );
    expect(markdown).toContain("[^Study]: First body.");
    expect(markdown).toContain("    Second paragraph.");
    expect(markdown).toContain("    3. Ordered body");
    expect(markdown.split("[^Study]:")).toHaveLength(2);
    expect(workspace.meta.docMetas).toHaveLength(1);
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

test("existing Markdown copy consumers report endnote placement loss and retain the complete body", async () => {
  const { workspace, store, note } = fixture();
  await insertFromMarkdown(undefined, localFootnoteSource, store, note);
  const definition = store.getBlocksByFlavour("myoxus:footnote-definition")[0]
    .model;
  store.updateBlock(definition, { placement: "endnote" });
  const notify = vi.fn();
  const std = footnoteClipboardScope(store, notify);
  const paragraph = store
    .getBlocksByFlavour("myoxus:paragraph")
    .find(({ model }) => model.text?.toString().startsWith("Read"))!.model;
  const slice = Slice.fromModels(store, [paragraph]);
  try {
    using job = store.getTransformer();
    const snapshot = job.sliceToSnapshot(slice)!;
    wrapFakeNote(snapshot);
    const copied = await new MixTextAdapter(
      job,
      store.provider,
      std.provider,
    ).fromSliceSnapshot({ snapshot, assets: job.assetsManager });
    expect(copied.file).toContain("[^Study]: First body.");
    expect(copied.file).toContain("    Second paragraph.");
    expect(copied.file).toContain("    3. Ordered body");
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ normalizedEndnotes: 1 }),
    );
    notify.mockClear();
    await getContentFromSlice(
      { std, store, selection: std.selection } as EditorHost,
      slice,
    );
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ normalizedEndnotes: 1 }),
    );
    expect(workspace.meta.docMetas).toHaveLength(1);
  } finally {
    std.unmount();
    workspace.dispose();
  }
});

const taskReferenceIdentity = {
  serverWorkspaceId: "07b4325f-c8ba-44b2-a9aa-4575bd5a3bd6",
  serverDatabaseId: "779cb334-7997-4047-90e1-71c23dd095d8",
  serverRowId: "e812080f-e010-4aab-8207-7ad45bd4acbb",
};

test("native Task reference roundtrip preserves the atomic SQL identity while remapping only the editor block", async () => {
  const { workspace, store, note } = fixture(
    taskReferenceIdentity.serverWorkspaceId,
  );
  using job = store.getTransformer([
    replaceIdMiddleware(workspace.idGenerator),
  ]);
  try {
    const id = store.addBlock("myoxus:database", taskReferenceIdentity, note);
    const snapshot = job.sliceToSnapshot(
      Slice.fromModels(store, [store.getModelById(id)!]),
    )!;
    expect(snapshot.content[0].props).toEqual({
      ...taskReferenceIdentity,
      serverViewId: null,
    });
    const copied = await job.snapshotToSlice(
      structuredClone(snapshot),
      store,
      note,
    );
    expect(copied?.content).toHaveLength(1);
    const copy = copied!.content[0];
    expect(copy.id).not.toBe(id);
    expect(copy.props).toMatchObject({
      ...taskReferenceIdentity,
      serverViewId: null,
    });
    expect(store.getBlocksByFlavour("myoxus:database")).toHaveLength(2);
  } finally {
    workspace.dispose();
  }
});

test("document Markdown export and HTML/plaintext adapters emit generic authenticated Task links without payload titles", async () => {
  const { workspace, store, note } = fixture(
    taskReferenceIdentity.serverWorkspaceId,
  );
  const files: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    files.push(blob as Blob);
    return "blob:task-reference-export";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  using job = store.getTransformer([docLinkBaseURLMiddleware(workspace.id)]);
  try {
    const id = store.addBlock("myoxus:database", taskReferenceIdentity, note);
    const snapshot = job.sliceToSnapshot(
      Slice.fromModels(store, [store.getModelById(id)!]),
    )!;
    const url = `${window.location.origin}/workspace/${workspace.id}/databases/${taskReferenceIdentity.serverDatabaseId}?rowId=${taskReferenceIdentity.serverRowId}`;
    await exportActions.exportToMarkdown(
      store,
      undefined,
      fixtureReferenceAccess(workspace),
    );
    expect(files).toHaveLength(1);
    const markdown = await files[0].text();
    expect(markdown).toContain(`[Task](${url})`);
    // Imported payload/display fields cannot become an export authorization grant.
    snapshot.content[0].props.title = "Private Task title";
    snapshot.content[0].props.source = { title: "Private source title" };
    snapshot.content[0].children.push({
      type: "block",
      id: "injected-child",
      flavour: "myoxus:paragraph",
      props: { text: { delta: [{ insert: "Private nested payload" }] } },
      children: [],
    });
    const staticMarkdown = await new MarkdownAdapter(
      job,
      store.provider,
    ).fromSliceSnapshot({ snapshot });
    expect(staticMarkdown.file.trim()).toBe(`[Task](${url})`);
    const html = await new HtmlAdapter(job, store.provider).fromSliceSnapshot({
      snapshot,
    });
    const view = document.createElement("div");
    view.innerHTML = html.file;
    expect(
      [...view.querySelectorAll("a")].map((link) => [
        link.textContent,
        link.href,
      ]),
    ).toEqual([["Task", url]]);
    expect(view.textContent?.trim()).toBe("Task");
    const plain = await new PlainTextAdapter(
      job,
      store.provider,
    ).fromSliceSnapshot({ snapshot });
    expect(plain.file.trim()).toBe(`[Task](${url})`);
    for (const output of [markdown, staticMarkdown.file, html.file, plain.file])
      expect(output).not.toContain("Private");
    const imported = await new MarkdownAdapter(
      job,
      store.provider,
    ).toBlockSnapshot({ file: markdown });
    expect(imported.children.map((block) => block.flavour)).not.toContain(
      "myoxus:database",
    );
    const deltas = imported.children.flatMap(
      (block) => (block.props.text as SnapshotText | undefined)?.delta ?? [],
    );
    expect(deltas).toContainEqual({
      insert: "Task",
      attributes: { link: url },
    });
  } finally {
    workspace.dispose();
  }
});

test.each(["foreign"] as const)(
  "static Task reference export is neutral for %s without a local identity fallback",
  async () => {
    const { workspace, store } = fixture(
      taskReferenceIdentity.serverWorkspaceId,
    );
    using job = store.getTransformer([docLinkBaseURLMiddleware(workspace.id)]);
    try {
      const props: Record<string, unknown> = {
        ...taskReferenceIdentity,
        title: "Private Task title",
        sourceTitle: "Private source title",
      };
      props.serverWorkspaceId = "08b4325f-c8ba-44b2-a9aa-4575bd5a3bd6";
      const snapshot = {
        type: "slice" as const,
        workspaceId: workspace.id,
        pageId: store.id,
        content: [
          {
            type: "block" as const,
            id: "unsafe-reference",
            flavour: "myoxus:database",
            props,
            children: [],
          },
        ],
      };
      const md = await new MarkdownAdapter(
        job,
        store.provider,
      ).fromSliceSnapshot({ snapshot });
      const html = await new HtmlAdapter(job, store.provider).fromSliceSnapshot(
        { snapshot },
      );
      const plain = await new PlainTextAdapter(
        job,
        store.provider,
      ).fromSliceSnapshot({ snapshot });
      expect(md.file.trim()).toBe("Target unavailable");
      expect(plain.file.trim()).toBe("Target unavailable");
      const view = document.createElement("div");
      view.innerHTML = html.file;
      expect(view.textContent?.trim()).toBe("Target unavailable");
      expect(view.querySelectorAll("a")).toHaveLength(0);
    } finally {
      workspace.dispose();
    }
  },
);
