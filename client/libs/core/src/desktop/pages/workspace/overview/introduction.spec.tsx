// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { Doc, DocService, DocsService } from "@myoxus/core/modules/doc";
import { DocRecordList } from "@myoxus/core/modules/doc/entities/record-list";
import { DocCreateMiddleware } from "@myoxus/core/modules/doc/providers/doc-create-middleware";
import { DocScope } from "@myoxus/core/modules/doc/scopes/doc";
import { DocPropertiesStore } from "@myoxus/core/modules/doc/stores/doc-properties";
import { DocsStore } from "@myoxus/core/modules/doc/stores/docs";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import {
  type Editor,
  EditorService,
  EditorsService,
} from "@myoxus/core/modules/editor";
import { EditorScope } from "@myoxus/core/modules/editor/scopes/editor";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { Framework, FrameworkRoot, LiveData, useService } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  BlockMetaService,
  FeatureFlagService,
  WriterInfoServiceExtension,
} from "@virgultum/editor/shared/services";
import {
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  type ParagraphBlockModel,
  RootBlockSchemaExtension,
} from "@virgultum/model";
import type { Store, YBlock } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { WorkspaceIntroduction } from "./introduction";

const fixtures = vi.hoisted(() => ({
  can: vi.fn(),
  page: undefined as Store | undefined,
  contextDoc: undefined as unknown,
  contextEditor: undefined as unknown,
}));
const read$ = new LiveData<boolean | undefined>(true);
vi.mock("@myoxus/i18n", async () =>
  (
    await import("../../../../modules/database/test-i18n-mock")
  ).createDatabaseTestI18nModule(),
);
vi.mock("@myoxus/core/editor/virgultum/doc-editor", () => ({
  VirgultumEditor: ({ page }: { page: Store }) => {
    // Resolve the real native service chain; a missing host scope fails here.
    fixtures.contextDoc = useService(DocService).doc;
    fixtures.contextEditor = useService(EditorService).editor;
    fixtures.page = page;
    return (
      <div data-testid="native-introduction">
        {page
          .getBlocksByFlavour("myoxus:paragraph")
          .map((block) =>
            (block.model as ParagraphBlockModel).props.text.toString(),
          )
          .join("")}
      </div>
    );
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  fixtures.page = undefined;
  fixtures.contextDoc = undefined;
  fixtures.contextEditor = undefined;
});

test("reading a sparse native introduction preserves source content, metadata and its editable host", async () => {
  const collection = new TestWorkspace({ id: "overview-readonly" });
  collection.storeExtensions = [
    RootBlockSchemaExtension,
    NoteBlockSchemaExtension,
    ParagraphBlockSchemaExtension,
    FeatureFlagService,
    BlockMetaService,
    WriterInfoServiceExtension({
      getWriterInfo: () => ({ id: "reader", name: "Reader" }),
    }),
  ];
  collection.meta.initialize();
  const leaf = collection.createDoc("source");
  leaf.load();
  // Native server/imported Pages may omit optional schema defaults. Opening a
  // fully initialized writable fixture would conceal hydration writes.
  const block = (id: string, flavour: string, children: string[]) =>
    new Y.Map<unknown>([
      ["sys:id", id],
      ["sys:flavour", flavour],
      ["sys:children", Y.Array.from(children)],
    ]) as YBlock;
  const root = block("root", "myoxus:page", ["note"]);
  root.set("prop:title", new Y.Text("Source"));
  const note = block("note", "myoxus:note", ["body"]);
  const body = block("body", "myoxus:paragraph", []);
  body.set("prop:text", new Y.Text("Real introduction body"));
  leaf.yBlocks.set("root", root);
  leaf.yBlocks.set("note", note);
  leaf.yBlocks.set("body", body);
  const writes = vi.fn();
  const rootWrites = vi.fn();
  leaf.spaceDoc.on("update", writes);
  collection.doc.on("update", rootWrites);
  const metadata = collection.doc.getMap("test-record-meta");
  const setMeta = vi.fn((patch: Record<string, unknown>) =>
    Object.entries(patch).forEach(([key, value]) => metadata.set(key, value)),
  );
  const record = {
    id: "source",
    meta$: new LiveData({ title: "Source", trash: false }),
    properties$: new LiveData({}),
    primaryMode$: new LiveData("page"),
    title$: new LiveData("Source"),
    trash$: new LiveData(false),
    setMeta,
  };
  const workspaceService = {
    workspace: {
      id: collection.id,
      docCollection: collection,
      engine: {
        doc: { addPriority: () => () => {} },
        indexer: { addPriority: () => () => {} },
      },
    },
  } as unknown as WorkspaceService;
  const store = {
    workspaceService,
    getVirgultumDoc: DocsStore.prototype.getVirgultumDoc,
    watchDocIds: () => new LiveData<string[]>([]),
    watchTrashDocIds: () => new LiveData<string[]>([]),
    watchNonTrashDocIds: () => new LiveData<string[]>([]),
    watchDocListReady: () => new LiveData(true),
    waitForDocLoadReady: async () => {},
  } as unknown as DocsStore;
  const framework = new Framework();
  framework
    .store(DocsStore, store)
    .store(DocPropertiesStore, {} as DocPropertiesStore)
    .entity(DocRecordList, [DocsStore])
    .service(DocsService, [
      DocsStore,
      DocPropertiesStore,
      [DocCreateMiddleware],
    ])
    .service(WorkspaceService, workspaceService)
    .service(DocumentMetadataCacheService, {
      observeSyncedVersionHead: () => () => {},
    } as unknown as DocumentMetadataCacheService)
    .service(GuardService, {
      can: fixtures.can,
      can$: () => read$,
    } as unknown as GuardService)
    .scope(DocScope)
    .entity(Doc, [
      DocScope,
      DocsStore,
      WorkspaceService,
      DocumentMetadataCacheService,
    ])
    .service(DocService);
  const provider = framework.provider();
  const docs = provider.get(DocsService);
  const originalList = docs.list;
  docs.list = { doc$: () => new LiveData(record) } as unknown as DocRecordList;
  const siblingView = leaf.getStore({ readonly: true });
  siblingView.load();
  const reading = docs.open("source", { readonly: true });
  if (!reading) throw new Error("Reading fixture could not open");
  const readingPage = reading.doc.virgultumDoc;
  const disposeReadingPage = vi.spyOn(readingPage, "dispose");
  const disposeEditor = vi.fn();
  const editor = {
    scope: undefined as EditorScope | undefined,
    dispose: disposeEditor,
  };
  framework
    .scope(DocScope)
    .service(EditorsService, {
      createEditor: () => {
        editor.scope = reading.doc.scope.framework.createScope(EditorScope, {
          editor: editor as unknown as Editor,
        });
        return editor;
      },
    } as unknown as EditorsService)
    .scope(EditorScope)
    .service(EditorService, { editor } as unknown as EditorService);
  fixtures.can.mockResolvedValue(true);
  let readingReleased = false;
  let editing: ReturnType<DocsService["open"]> = null;
  let fakeTimers = false;
  try {
    const mounted = render(
      <MyoxusUIProvider>
        <FrameworkRoot framework={provider}>
          <WorkspaceIntroduction docId="source" />
        </FrameworkRoot>
      </MyoxusUIProvider>,
    );
    await screen.findByText("Real introduction body");
    expect(fixtures.contextDoc).toBe(reading.doc);
    expect(fixtures.contextEditor).toBe(editor);
    expect(fixtures.page?.doc).toBe(leaf);
    expect(fixtures.page?.readonly).toBe(true);
    expect(readingPage).not.toBe(siblingView);
    expect(writes).not.toHaveBeenCalled();
    expect(rootWrites).not.toHaveBeenCalled();
    expect(docs.loaded("source")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fakeTimers = true;
    reading.release();
    readingReleased = true;

    // A genuine edit from another host remains live, but its reading view must
    // not stamp attribution or project a second modified-date write.
    body.set("prop:type", "h2");
    expect(
      (readingPage.getModelById("body") as ParagraphBlockModel).props.type,
    ).toBe("h2");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(body.has("prop:meta:updatedAt")).toBe(false);
    expect(setMeta).not.toHaveBeenCalled();
    expect(rootWrites).not.toHaveBeenCalled();

    mounted.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disposeReadingPage).toHaveBeenCalledTimes(1);
    expect(leaf.getStore({ readonly: true })).toBe(siblingView);
    expect(disposeEditor).toHaveBeenCalledTimes(1);
    editing = docs.open("source");
    if (!editing) throw new Error("Editable source could not open");
    const source = editing.doc.virgultumDoc;
    expect(source.readonly).toBe(false);
    leaf.spaceDoc.transact(() => {});
    expect(setMeta).not.toHaveBeenCalled();
    const paragraph = source.getModelById("body") as ParagraphBlockModel;
    source.updateBlock(paragraph, { type: "text" });
    expect(paragraph.props.text.toString()).toBe("Real introduction body");
    expect(setMeta).toHaveBeenCalled();
  } finally {
    cleanup();
    if (!readingReleased) reading.release();
    const editablePage = editing?.doc.virgultumDoc;
    editing?.release();
    editablePage?.dispose();
    siblingView.dispose();
    if (fakeTimers) await vi.advanceTimersByTimeAsync(1000);
    originalList.dispose();
    provider.dispose();
    leaf.spaceDoc.off("update", writes);
    collection.doc.off("update", rootWrites);
    leaf.dispose();
    collection.dispose();
  }
});
