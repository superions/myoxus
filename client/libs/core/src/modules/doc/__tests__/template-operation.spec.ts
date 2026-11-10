// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readZipFixture } from "../../../__tests__/zip-fixture";
import { SurfaceBlockSchemaExtension } from "@virgultum/editor/blocks/surface";
import {
  nativeDocumentBundles,
  customSourceMetadata,
} from "../../template-doc/services/source-metadata";
import { readNativeTemplateBundle } from "../../template-doc/services/native-bundle";

import { Framework, LiveData } from "@myoxus/infra";
import {
  DatabaseBlockSchemaExtension,
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  TableBlockSchemaExtension,
  ListBlockSchemaExtension,
  DividerBlockSchemaExtension,
  CalloutBlockSchemaExtension,
  ImageBlockSchemaExtension,
  BpmnBlockSchemaExtension,
  type TableBlockModel,
  type ListBlockModel,
  type RootBlockModel,
  type ParagraphBlockModel,
} from "@virgultum/model";
import { Slice, Text, type Store } from "@virgultum/store";
import {
  DocumentFieldSchema,
  type MyoxusTextAttributes,
} from "@virgultum/shared/types";
import type { BlockStdScope } from "@virgultum/std";
import type { BuildingBlockTarget } from "../../../editor/virgultum/doc-editor/building-block-target";
import { commitBuildingBlockSection } from "../../template-doc/services/template-section-insertion";
import { TestWorkspace } from "@virgultum/store/test";
import { createBlankBpmnSource } from "@myoxus/bpmn-editor/source";
import { Subscription } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";
import {
  applyUpdate,
  Doc as YDoc,
  Map as YMap,
  Array as YArray,
  Text as YText,
  encodeStateAsUpdate,
  createRelativePositionFromTypeIndex,
} from "yjs";

import {
  FolderStore,
  type TemplateFolderResolution,
} from "../../organize/stores/folder";
import type { TemplateCreationContext } from "../../template-doc/services/template-instantiation";
import { TemplateInstantiationService } from "../../template-doc/services/template-instantiation";
import { TemplateDocService } from "../../template-doc/services/template-doc";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "../../template-doc/services/template-instantiation-error";
import type { Doc } from "../entities/doc";
import type { DocRecord } from "../entities/record";
import { DocCreateMiddleware } from "../providers/doc-create-middleware";
import { DocRecordList } from "../entities/record-list";
import { DocsStore } from "../stores/docs";
import { DocPropertiesStore } from "../stores/doc-properties";
import { DocsService } from "../services/docs";

import { expandAndApplyTemplateUnits } from "../services/template-repeat";
import type {
  TemplateVariable,
  TemplateVariables,
} from "../services/template-repeat";

const preferences = {
  locale: "de",
  timezone: "Europe/Berlin",
  dateFormat: "locale",
  timeFormat: "24-hour",
} as const;
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Native Stores/Transformer exercise copy, marks and Yjs observation; only remote facts and Core record IO are fixtures. */
function setup(workspaceId = "template-operation") {
  const collection = new TestWorkspace({ id: workspaceId });
  collection.meta.initialize();
  const stores = new Map<string, Store>();
  const records = new Map<string, ReturnType<typeof createRecord>>();
  function createRecord(id: string, empty = false) {
    const leaf = collection.createDoc(id);
    leaf.load();
    const store = leaf.getStore({
      extensions: [
        DatabaseBlockSchemaExtension,
        RootBlockSchemaExtension,
        NoteBlockSchemaExtension,
        ParagraphBlockSchemaExtension,
        TableBlockSchemaExtension,
        ListBlockSchemaExtension,
        SurfaceBlockSchemaExtension,
        DividerBlockSchemaExtension,
        CalloutBlockSchemaExtension,
        ImageBlockSchemaExtension,
        BpmnBlockSchemaExtension,
      ],
    });
    stores.set(id, store);
    if (!empty) {
      store.addBlock("myoxus:page", { title: new Text(id) });
      const note = store.addBlock("myoxus:note", {}, store.root!.id);
      store.addBlock(
        "myoxus:paragraph",
        {
          text: new Text(
            id === "source" ? "{{workspace.name}}" : "Original content",
          ),
        },
        note,
      );
    }
    const meta$ = new LiveData({ title: id, trash: false });
    const properties$ = new LiveData<Record<string, unknown>>({
      id,
      "custom:fixture": id,
    });
    const record = {
      id,
      yDoc: store.spaceDoc,
      virgultumDoc: store,
      meta$,
      properties$,
      title$: meta$.selector((meta) => meta.title),
      trash$: meta$.selector((meta) => meta.trash),
      isTemplate$: new LiveData(id === "source"),
      waitForSyncReady: vi.fn(async () => {}),
      getProperties: () => ({ ...properties$.value }),
      updateProperties: vi.fn((patch: Record<string, unknown>) => {
        properties$.setValue({ ...properties$.value, ...patch });
      }),
      changeDocTitle: vi.fn((title: string) => {
        meta$.setValue({ ...meta$.value, title });
      }),
      release: vi.fn(),
      moveToTrash: vi.fn(() => meta$.setValue({ ...meta$.value, trash: true })),
    };
    records.set(id, record);
    return record;
  }
  const source = createRecord("source"),
    target = createRecord("target");
  // This consuming tier receives already-attested literal facts. Member
  // traversal and creator matching are covered at their application owner.
  const facts: Record<string, TemplateVariable> = {
    "workspace.name": "Team {{literal}}",
    "workspace.members": [{ name: "Creator", email: "creator@example.test" }],
    "creator.name": "Creator",
    "creator.email": "creator@example.test",
    "document.created_at.date": "2020-01-02T23:15:00.000Z",
    "document.created_at.time": "2020-01-02T23:15:00.000Z",
    "document.created_at.datetime": "2020-01-02T23:15:00.000Z",
    organization_name: "Organization",
    organization_unit_name: "Owner team",
    folder_name: "Destination",
    parent_page_title: "Current parent",
  };
  const preflight = vi.fn(async () => {});
  const creationFacts = vi.fn(async () => {});
  const readTemplateValues = vi.fn(
    async (
      requested: readonly string[],
      _target: string | undefined,
      _context: TemplateCreationContext,
      signal: AbortSignal,
      deferCreation = false,
    ): Promise<TemplateVariables> => {
      await waitForTemplateOperation(
        deferCreation ? preflight() : creationFacts(),
        signal,
      );
      return Object.fromEntries(
        requested
          .filter(
            (path) =>
              !(
                deferCreation &&
                (path.startsWith("creator.") ||
                  path.startsWith("document.created_at."))
              ),
          )
          .map((path) => [path, facts[path]]),
      );
    },
  );
  const context = {
    id: "workspace",
    serverBacked: true,
    name: " Team {{literal}} ",
  };
  const folder = vi.fn((): TemplateFolderResolution => ({
    status: "resolved",
    folderId: "folder",
    name: "Destination",
    path: ["Root", "Destination"],
  }));
  const folderReady = vi.fn(async () => {});
  const setDocTemplateStateSetting = vi.fn(async () => {});
  const setDocTemplateClassification = vi.fn(async () => {});
  const waitForCreateAcknowledgement = vi.fn(async () => {});
  const waitForDocSynced = vi.fn(async () => {});
  const isTemplate = vi.fn(async (id: string) => id === "source");
  const setJournalTemplate = vi.fn();
  const store = {
    templateWorkspaceContext: context,
    readTemplateValues,
    waitForDocLoadReady: folderReady,
    watchTemplateSyncFailure: () => new Subscription(),
    getVirgultumCollection: () => collection,
    getVirgultumDoc: (id: string) => stores.get(id),
    watchDocIds: () => new LiveData<string[]>([]),
    watchTrashDocIds: () => new LiveData<string[]>([]),
    watchNonTrashDocIds: () => new LiveData<string[]>([]),
    watchDocListReady: () => new LiveData(true),
    setDocTemplateStateSetting,
    setDocTemplateClassification,
    waitForCreateAcknowledgement,
    waitForDocSynced,
    waitForTemplateSourceSynced: vi.fn(async () => {}),
    getDocMetaSnapshot: (id: string) => records.get(id)?.meta$.value ?? {},
    setManyDocMeta: (changes: { id: string; meta: { trash: boolean } }[]) =>
      changes.forEach(({ id, meta }) => {
        const record = records.get(id)!;
        record.meta$.setValue({ ...record.meta$.value, ...meta });
      }),
  };
  const framework = new Framework();
  framework
    .store(FolderStore, {
      resolveTemplateFolder: folder,
    } as unknown as FolderStore)
    .store(DocsStore, store as unknown as DocsStore)
    .store(DocPropertiesStore, {} as DocPropertiesStore)
    .entity(DocRecordList, [DocsStore])
    .service(DocsService, [
      DocsStore,
      DocPropertiesStore,
      [DocCreateMiddleware],
    ])
    .service(TemplateDocService, {
      resolveSourceMetadataForDoc: async (id: string) =>
        customSourceMetadata(id, undefined),
      assertDocumentTemplateSource:
        TemplateDocService.prototype.assertDocumentTemplateSource,
      assertCustomClassificationChange:
        TemplateDocService.prototype.assertCustomClassificationChange,
      invalidateTemplateSuggestions: vi.fn(),
      setting: {
        loading$: new LiveData(false),
        pageTemplateDocId$: new LiveData<string | undefined>(undefined),
        journalTemplateDocId$: new LiveData<string | undefined>(undefined),
        updateJournalTemplateDocId: setJournalTemplate,
      },
      list: { isTemplate },
    } as unknown as TemplateDocService)
    .service(TemplateInstantiationService, [DocsService, TemplateDocService]);
  const provider = framework.provider();
  const service = provider.get(DocsService);
  const instantiation = provider.get(TemplateInstantiationService);
  const templateDocService = provider.get(TemplateDocService);
  const originalList = service.list;
  service.list = {
    doc$: (id: string) => new LiveData(records.get(id)),
  } as unknown as DocRecordList;
  vi.spyOn(service, "open").mockImplementation((id) => {
    const record = records.get(id);
    return record
      ? { doc: record as unknown as Doc, release: record.release }
      : null;
  });
  vi.spyOn(service, "createDoc").mockImplementation(
    () => createRecord("new-target") as unknown as DocRecord,
  );
  cleanup.push(() => {
    instantiation.dispose();
    service.dispose();
    originalList.dispose();
    for (const doc of collection.docs.values()) doc.dispose();
    collection.dispose();
  });
  const apply = (
    title?: string,
    targetDocId: string | undefined = "target",
    creationContext: TemplateCreationContext = {},
  ) =>
    service.applyTemplate({
      creationContext,
      sourceDocId: "source",
      targetDocId,
      title,
      variables: { date: "Legacy date" },
      regionalPreferences: preferences,
    });
  const paragraph = (id: string) =>
    stores
      .get(id)!
      .getAllModels()
      .find((m) => m.flavour === "myoxus:paragraph")!;
  const setSource = (value: string) =>
    stores
      .get("source")!
      .updateBlock(paragraph("source"), { text: new Text(value) });
  const body = (id = "target") =>
    String((paragraph(id) as unknown as { text: Text }).text);
  return {
    service,
    instantiate: instantiation,
    templateDocService,
    source,
    target,
    stores,
    records,
    facts,
    preflight,
    creationFacts,
    readTemplateValues,
    context,
    folder,
    folderReady,
    setJournalTemplate,
    setDocTemplateStateSetting,
    setDocTemplateClassification,
    waitForCreateAcknowledgement,
    waitForDocSynced,
    isTemplate,
    createRecord,
    apply,
    paragraph,
    setSource,
    body,
  };
}

test("document duplication retains exact BPMN heads and rejects failed content copy", async () => {
  const fixture = setup("bpmn-document-copy");
  const source = fixture.stores.get("source")!;
  const note = source.root!.children[0];
  const field = {
    type: "input" as const,
    id: "source-answer",
    definition: { kind: "text" as const, label: "Answer", required: false },
    value: "Literal {{answer}}",
  };
  const metadata = {
    type: "metadata" as const,
    id: "source-title",
    key: "title" as const,
    format: "text" as const,
  };
  source.updateBlock(fixture.paragraph("source"), {
    text: new Text<MyoxusTextAttributes>([
      { insert: "Answer: " },
      { insert: " ", attributes: { documentField: field } },
      { insert: "Title: " },
      { insert: " ", attributes: { documentField: metadata } },
    ]),
  });
  const xml = "\ufeff" + createBlankBpmnSource().replaceAll("\n", "\r\n");
  const heads = {
    left: xml,
    right: xml.replace("<process ", '<process name="Peer" '),
  };
  const links = {
    left: JSON.stringify({ parent: null, supersedes: [] }),
    right: JSON.stringify({ parent: null, supersedes: [] }),
  };
  const id = source.addBlock(
    "myoxus:bpmn",
    {
      title: new Text("Procurement"),
      sourceHeads: heads,
      sourceLinks: links,
      selectedHead: "",
      preview: { revision: "left", sourceId: "retained-preview" },
    },
    note.id,
  );
  Object.assign(fixture.source, {
    workspace: {
      flavour: "local",
      scope: {
        get: () => ({
          getPageTags: async () => [],
          setPageTags: async () => {},
        }),
      },
    },
  });
  const targetId = await fixture.service.duplicate("source");
  const target = fixture.stores.get(targetId)!;
  const sourceText = (fixture.paragraph("source") as unknown as { text: Text })
    .text;
  const copiedText = (fixture.paragraph(targetId) as unknown as { text: Text })
    .text;
  const sourceField = sourceText
    .toDelta()
    .find((run) => run.attributes?.documentField)?.attributes?.documentField;
  const copiedField = copiedText
    .toDelta()
    .find((run) => run.attributes?.documentField)?.attributes?.documentField;
  expect(sourceField).toEqual(field);
  expect(copiedField).toMatchObject({ ...field, id: expect.any(String) });
  expect(copiedField?.id).not.toBe(field.id);
  const copiedMetadata = copiedText
    .toDelta()
    .find((run) => run.attributes?.documentField?.type === "metadata")
    ?.attributes?.documentField;
  expect(copiedMetadata).toMatchObject({ ...metadata, id: expect.any(String) });
  expect(copiedMetadata?.id).not.toBe(metadata.id);
  const copy = target.getBlocksByFlavour("myoxus:bpmn")[0].model;
  expect(copy.id).not.toBe(id);
  expect(
    (copy.yBlock.get("prop:sourceHeads") as YMap<string>).toJSON(),
  ).toEqual(heads);
  expect(
    (copy.yBlock.get("prop:sourceLinks") as YMap<string>).toJSON(),
  ).toEqual(links);
  expect(copy.yBlock.get("prop:selectedHead")).toBe("");
  (copy.yBlock.get("prop:sourceHeads") as YMap<string>).set(
    "left",
    "copied document edit",
  );
  expect(
    (
      source.getBlock(id)!.model.yBlock.get("prop:sourceHeads") as YMap<string>
    ).get("left"),
  ).toBe(xml);

  const failure = setup("bpmn-document-copy-failure");
  vi.spyOn(
    failure.service as unknown as { replaceDocContent(): Promise<void> },
    "replaceDocContent",
  ).mockRejectedValue(new Error("CONTENT_COPY_FAILED"));
  await expect(failure.service.duplicate("source")).rejects.toThrow(
    "CONTENT_COPY_FAILED",
  );
  expect(failure.records.get("new-target")!.moveToTrash).toHaveBeenCalledOnce();
  expect(failure.source.release).toHaveBeenCalledOnce();
  expect(failure.records.get("new-target")!.release).toHaveBeenCalledOnce();
});

test("native source copy retains effective classification and waits for content and attribution", async () => {
  const fixture = setup();
  let finishContent!: () => void;
  fixture.waitForDocSynced.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishContent = resolve;
      }),
  );
  let finishAttribution!: () => void;
  fixture.setDocTemplateStateSetting.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishAttribution = resolve;
      }),
  );

  let completed = false;
  const classification = {
    category: "building-blocks",
    tags: ["technical-projects"],
  };
  vi.spyOn(
    fixture.templateDocService,
    "resolveSourceMetadataForDoc",
  ).mockResolvedValue({
    ...customSourceMetadata("source", classification),
    source: "bundle",
    slug: "block-fixture",
  });
  const pending = fixture.service
    .copyTemplateSource("source")
    .then((record) => {
      completed = true;
      return record;
    });
  await vi.waitFor(() =>
    expect(fixture.waitForDocSynced).toHaveBeenCalledOnce(),
  );
  expect(fixture.setDocTemplateStateSetting).not.toHaveBeenCalled();
  finishContent();
  await vi.waitFor(() => {
    expect(fixture.setDocTemplateStateSetting).toHaveBeenCalledOnce();
  });
  expect(completed).toBe(false);
  finishAttribution();

  await expect(pending).resolves.toMatchObject({ id: "new-target" });
  expect(fixture.body("new-target")).toBe("{{workspace.name}}");
  expect(fixture.setDocTemplateStateSetting).toHaveBeenCalledWith(
    "new-target",
    true,
    expect.any(AbortSignal),
    "custom",
    classification,
  );
});

test("prepared native sections reject missing models and commit with one isolated undo unit", async () => {
  const fixture = setup();
  const source = fixture.stores.get("source")!;
  const target = fixture.stores.get("target")!;
  const sourceNote = source.root!.children.find(
    (block) => block.flavour === "myoxus:note",
  )!;
  const targetNote = target.root!.children.find(
    (block) => block.flavour === "myoxus:note",
  )!;
  const paragraph = fixture.paragraph("target");
  target.updateBlock(paragraph, {
    text: new Text([
      { insert: "Original " },
      { insert: "content", attributes: { bold: true } },
    ]),
    textAlign: "right",
  });
  source.addBlock(
    "myoxus:list",
    { type: "todo", checked: false, text: new Text("Check the result") },
    sourceNote.id,
  );
  using transformer = fixture.service.createDocTransformer();
  const body = transformer.sliceToSnapshot(
    Slice.fromModels(source, sourceNote.children),
  )!;
  const before = encodeStateAsUpdate(target.spaceDoc);
  const invalid = structuredClone(body);
  invalid.content[1].flavour = "myoxus:missing-native-model";
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    transformer.prepareSlice(invalid, target, targetNote.id),
  ).rejects.toThrow("conversion failed before insertion");
  consoleError.mockRestore();
  expect(encodeStateAsUpdate(target.spaceDoc)).toEqual(before);
  const prepared = await transformer.prepareSlice(body, target, targetNote.id);
  expect(encodeStateAsUpdate(target.spaceDoc)).toEqual(before);
  const destination: BuildingBlockTarget = {
    std: {
      store: target,
      host: { isConnected: true },
    } as unknown as BlockStdScope,
    workspaceId: target.workspace.id,
    docId: target.id,
    noteId: targetNote.id,
    blockId: paragraph.id,
    afterSelection: false,
    selection: [],
    caret: createRelativePositionFromTypeIndex(paragraph.text!.yText, 9),
  };
  const section = commitBuildingBlockSection(
    destination,
    {
      snapshot: prepared.snapshot,
      assertCurrent: () => {},
      commit: (index, write) =>
        transformer.commitPreparedSlice(
          prepared,
          target,
          targetNote.id,
          index,
          write,
        ),
    },
    new AbortController().signal,
  );
  const tail = targetNote.children.at(-1)! as ParagraphBlockModel;
  expect(tail.text!.toDelta()).toEqual([
    { insert: "content", attributes: { bold: true } },
  ]);
  expect(tail.props.textAlign).toBe("right");
  expect(targetNote.children.map((block) => block.id)).toEqual([
    fixture.paragraph("target").id,
    ...section.content.map((block) => block.id),
    tail.id,
  ]);
  target.undo();
  expect(targetNote.children.map((block) => block.id)).toEqual([
    fixture.paragraph("target").id,
  ]);
  expect(fixture.body()).toBe("Original content");
  target.redo();
  expect(targetNote.children.map((block) => block.id)).toEqual([
    fixture.paragraph("target").id,
    ...section.content.map((block) => block.id),
    tail.id,
  ]);
  expect(fixture.target.title$.value).toBe("target");
  expect(fixture.target.getProperties()["custom:fixture"]).toBe("target");
  expect(fixture.body("source")).toBe("{{workspace.name}}");
});

function nativeBlockData(doc: YDoc): unknown {
  const capture = (value: unknown): unknown => {
    if (value instanceof YText) return { delta: value.toDelta() };
    if (value instanceof YMap)
      return Object.fromEntries(
        [...value.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, capture(child)]),
      );
    if (value instanceof YArray) return value.toArray().map(capture);
    return value;
  };
  return capture(doc.getMap("blocks"));
}

function nativeCreationFixture() {
  const fixture = setup();
  vi.mocked(fixture.service.createDoc).mockImplementation((options) => {
    expect(options?.skipInit).toBe(true);
    const record = fixture.createRecord("native-copy", true);
    record.meta$.setValue({ title: options?.title ?? "", trash: false });
    return record as unknown as DocRecord;
  });
  return fixture;
}

const loadPrepared = async (asset: string) =>
  new Uint8Array(
    readFileSync(
      resolve(process.cwd(), "client/libs/core/public/document-bundles", asset),
    ),
  );

test("native artwork guide persists its image before publishing an editable reader", async () => {
  const fixture = nativeCreationFixture();
  const bundle = nativeDocumentBundles.find(
    (entry) => entry.template_id === "welcome-myoxus",
  )!;
  const selected = await readNativeTemplateBundle(bundle, "de", loadPrepared);
  const blobs = fixture.stores.get("source")!.workspace.blobSync;
  const upload = vi.spyOn(blobs, "upload").mockResolvedValue(true);
  const record = await fixture.service.importNativeTemplateDoc(
    selected.content,
    selected.title,
    "guide",
  );
  const imported = fixture.stores.get(record.id)!;
  const image = [...imported.spaceDoc.getMap("blocks").values()].find(
    (block) =>
      block instanceof YMap && block.get("sys:flavour") === "myoxus:image",
  ) as YMap<unknown>;
  const key = image.get("prop:sourceId") as string;
  const persisted = await blobs.get(key);
  const sourceBundle = await readZipFixture(
    readFileSync(
      resolve(
        process.cwd(),
        "server/templates/documents",
        bundle.template_id,
        `${bundle.version}.zip`,
      ),
    ),
  );
  const archive = await readZipFixture(
    sourceBundle.get("content.template.zip")!,
  );
  const original = [...archive].find(
    ([name]) => name.startsWith("assets/") && !name.endsWith("/"),
  )![1];
  // Compare every byte without Vitest traversing a megabyte-sized typed array
  // element by element; import completion and the byte invariant stay unchanged.
  expect(
    Buffer.from(await persisted!.arrayBuffer()).equals(Buffer.from(original)),
  ).toBe(true);
  expect(upload).toHaveBeenCalledWith(key);
  expect(image.get("prop:caption")).toBeTruthy();
  expect(
    imported.getAllModels().some((model) => model.flavour === "myoxus:table"),
  ).toBe(true);
  expect(fixture.setDocTemplateStateSetting).not.toHaveBeenCalled();
  expect(fixture.source.trash$.value).toBe(false);
});

// Exercise actual committed Yjs bytes and the real consuming document method.
// Mocking ZIP import hid a format regression even though byte-port tests passed.
test.each(
  [
    { templateId: "meeting-agenda", locale: "de" },
    { templateId: "databases-guide-myoxus", locale: "en" },
  ].map(({ templateId, locale }) => ({
    bundle: nativeDocumentBundles.find(
      (bundle) => bundle.template_id === templateId,
    )!,
    locale,
  })),
)(
  "native $bundle.template_id / $locale imports full blocks through the document lifecycle",
  async ({ bundle, locale }) => {
    const fixture = nativeCreationFixture();
    const protectedSource = nativeBlockData(
      fixture.stores.get("source")!.spaceDoc,
    );
    const protectedTarget = nativeBlockData(
      fixture.stores.get("target")!.spaceDoc,
    );
    const selected = await readNativeTemplateBundle(
      bundle,
      locale,
      loadPrepared,
    );
    if (selected.content.kind !== "yjs")
      throw new Error("Expected raw native Yjs content");
    // Both sides must materialize through the native schemas: sparse bundles
    // acquire defaults when opened, while authored props and rich text stay exact.
    const reference = fixture.createRecord("native-reference", true);
    applyUpdate(reference.yDoc, selected.content.bytes);
    const expectedBlocks = nativeBlockData(reference.yDoc);
    const record = await fixture.service.importNativeTemplateDoc(
      selected.content,
      selected.title,
      bundle.purpose ?? "template",
    );
    const imported = fixture.stores.get(record.id)!;
    expect((imported.root as RootBlockModel).props.title.toString()).toBe(
      selected.title,
    );
    expect(nativeBlockData(imported.spaceDoc)).toEqual(expectedBlocks);
    expect(
      fixture.waitForCreateAcknowledgement,
    ).toHaveBeenCalledExactlyOnceWith(record.id, expect.any(AbortSignal));
    expect(fixture.waitForDocSynced).toHaveBeenCalledExactlyOnceWith(
      record.id,
      expect.any(AbortSignal),
    );
    if (bundle.purpose === "guide")
      expect(fixture.setDocTemplateStateSetting).not.toHaveBeenCalled();
    else
      expect(
        fixture.setDocTemplateStateSetting,
      ).toHaveBeenCalledExactlyOnceWith(
        record.id,
        true,
        expect.any(AbortSignal),
      );
    expect(nativeBlockData(fixture.stores.get("source")!.spaceDoc)).toEqual(
      protectedSource,
    );
    expect(nativeBlockData(fixture.stores.get("target")!.spaceDoc)).toEqual(
      protectedTarget,
    );
  },
);

test.each(["persistence"] as const)(
  "native %s failure compensates only its new document",
  async (stage) => {
    const fixture = nativeCreationFixture();
    const source = fixture.stores.get("source")!.spaceDoc;
    const protectedSource = nativeBlockData(source);
    const protectedTarget = nativeBlockData(
      fixture.stores.get("target")!.spaceDoc,
    );
    if (stage === "persistence")
      fixture.waitForDocSynced.mockRejectedValueOnce(
        new Error("native persistence failed"),
      );
    else if (stage === "creation")
      fixture.waitForCreateAcknowledgement.mockRejectedValueOnce(
        new Error("native creation failed"),
      );
    else
      fixture.setDocTemplateStateSetting.mockRejectedValueOnce(
        new Error("native attribution failed"),
      );
    await expect(
      fixture.service.importNativeTemplateDoc(
        { kind: "yjs", bytes: encodeStateAsUpdate(source) },
        "Captured",
        "template",
      ),
    ).rejects.toThrow(`native ${stage} failed`);
    expect(fixture.records.get("native-copy")!.trash$.value).toBe(true);
    expect(fixture.source.trash$.value).toBe(false);
    expect(fixture.target.trash$.value).toBe(false);
    expect(nativeBlockData(source)).toEqual(protectedSource);
    expect(nativeBlockData(fixture.stores.get("target")!.spaceDoc)).toEqual(
      protectedTarget,
    );
  },
);

test("template attribution cannot overtake the durable creation acknowledgement", async () => {
  const fixture = setup();
  let finishCreation!: () => void;
  fixture.waitForCreateAcknowledgement.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
  );

  const pending = fixture.service.createTemplateDoc();
  await Promise.resolve();
  expect(fixture.setDocTemplateStateSetting).not.toHaveBeenCalled();

  finishCreation();
  await pending;
  expect(fixture.setDocTemplateStateSetting).toHaveBeenCalledOnce();
});

test("ordinary provisioned builder content waits for creation without template attribution", async () => {
  const fixture = setup();
  let finishCreation!: () => void;
  fixture.waitForCreateAcknowledgement.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
  );
  let completed = false;

  const pending = fixture.service.createProvisionedDoc().then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  finishCreation();
  await pending;
  expect(fixture.setDocTemplateStateSetting).not.toHaveBeenCalled();
});

test.each([
  { retain: true, early: false },
  { retain: true, early: true },
  { retain: false, early: false },
])(
  "provisioning failure retains identity only for explicit recovery ($retain, early $early)",
  async ({ retain, early }) => {
    const fixture = setup();
    const id = "builder-target";
    vi.mocked(fixture.service.createDoc).mockImplementation((options) => {
      const record = fixture.createRecord(options!.id!);
      if (early) throw new Error("initialization failed");
      return record as unknown as DocRecord;
    });
    fixture.waitForCreateAcknowledgement.mockRejectedValueOnce(
      new Error("acknowledgement failed"),
    );
    const pending = fixture.service.createProvisionedDoc(
      { id },
      retain ? { retainOnFailure: true } : undefined,
    );
    if (retain)
      await expect(pending).rejects.toMatchObject({
        name: "DocProvisioningError",
        docId: id,
      });
    else await expect(pending).rejects.toThrow("acknowledgement failed");
    expect(fixture.records.get(id)!.trash$.value).toBe(!retain);
    expect(fixture.source.trash$.value).toBe(false);
    expect(fixture.target.trash$.value).toBe(false);
  },
);

test("new template targets wait for creation acknowledgement before writes", async () => {
  const fixture = setup();
  let finishCreation!: () => void;
  fixture.waitForCreateAcknowledgement.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
  );

  const pending = fixture.service.applyTemplate({
    creationContext: {},
    sourceDocId: "source",
    title: "Applied title",
    variables: { date: "Legacy date" },
    regionalPreferences: preferences,
  });
  await vi.waitFor(() => {
    expect(fixture.waitForCreateAcknowledgement).toHaveBeenCalledOnce();
  });
  expect(fixture.records.get("new-target")?.title$.value).toBe("new-target");

  finishCreation();
  await expect(pending).resolves.toBe("new-target");
  expect(fixture.records.get("new-target")?.title$.value).toBe("Applied title");
});

test("template attribution failure trashes only the document created by the attempt", async () => {
  const fixture = setup();
  fixture.setDocTemplateStateSetting.mockRejectedValueOnce(
    new Error("attribution failed"),
  );

  await expect(fixture.service.createTemplateDoc()).rejects.toThrow(
    "attribution failed",
  );
  expect(fixture.records.get("new-target")?.trash$.value).toBe(true);
  expect(fixture.source.trash$.value).toBe(false);
  expect(fixture.target.trash$.value).toBe(false);
});

/** One native source covers independent list/paragraph/row scopes and the
 * Store projection boundary that cannot be modelled with addBlock spies. */
function repeatSource(f: ReturnType<typeof setup>) {
  const source = f.stores.get("source")!;
  const parent = source.root!.children[0];
  const binding = { source: "workspace.members", alias: "member" };
  source.updateBlock(f.paragraph("source"), {
    text: new Text("{{creator.name}}: {{member.name}}"),
    repeat: binding,
  });
  source.addBlock(
    "myoxus:list",
    {
      type: "todo",
      checked: false,
      repeat: binding,
      text: new Text([
        { insert: "{{member.name}}", attributes: { bold: true } },
        { insert: " · {{member.email}}" },
      ]),
    },
    parent,
  );
  source.addBlock(
    "myoxus:list",
    {
      type: "bulleted",
      repeat: binding,
      text: new Text("{{member.email}}"),
    },
    parent,
  );
  source.addBlock(
    "myoxus:table",
    {
      headerRows: 1,
      rows: {
        // Fractional keys use binary order: `Zz` precedes `a0`, unlike many
        // locale collators. This fixture protects the positional header gate.
        header: { rowId: "header", order: "Zz" },
        r: { rowId: "r", order: "a0", repeat: binding },
      },
      columns: {
        name: { columnId: "name", order: "a0", width: 240 },
        email: { columnId: "email", order: "a1" },
      },
      cells: {
        "header:name": { text: new Text("Name") },
        "header:email": { text: new Text("Email") },
        "r:name": {
          backgroundColor: "--myoxus-sem-status-error-paper",
          text: new Text([
            { insert: "{{member.name}}", attributes: { italic: true } },
          ]),
        },
        "r:email": { text: new Text("{{member.email}}") },
      },
    },
    parent,
  );
  return source;
}

test("native repeats preserve order, pairing, marks and fresh identities from one preflight inventory", async () => {
  const f = setup();
  const source = repeatSource(f);
  const prototype = source
    .getAllModels()
    .find((model) => model.flavour === "myoxus:table") as TableBlockModel;
  const answer = prototype.props.cells["r:name"].text;
  source.updateBlock(f.paragraph("source"), { textProtection: "source" });
  prototype.props.cells["r:name"].textProtection = "source";
  answer.insert(" ", answer.length, {
    documentField: DocumentFieldSchema.parse({
      type: "input",
      id: "prototype-answer",
      definition: {
        kind: "text",
        label: "Answer",
        required: false,
        default: "Initial {{literal}}",
      },
      value: "Preview answer",
    }),
  });
  const before = encodeStateAsUpdate(source.spaceDoc);
  f.facts["creator.name"] = "Ada {{literal}}";
  f.facts["workspace.members"] = [
    { name: "Ada {{literal}}", email: "ada@example.test" },
    { name: "Bea", email: "bea@example.test" },
  ];
  await f.apply();
  const target = f.stores.get("target")!;
  const units = target.root!.children[0].children;
  expect(units.map((model) => model.flavour)).toEqual([
    "myoxus:paragraph",
    "myoxus:paragraph",
    "myoxus:list",
    "myoxus:list",
    "myoxus:list",
    "myoxus:list",
    "myoxus:table",
  ]);
  expect(units.slice(0, 6).map((model) => model.text!.toString())).toEqual([
    "Ada {{literal}}: Ada {{literal}}",
    "Ada {{literal}}: Bea",
    "Ada {{literal}} · ada@example.test",
    "Bea · bea@example.test",
    "ada@example.test",
    "bea@example.test",
  ]);
  expect(
    units
      .slice(0, 2)
      .map((model) => (model as ParagraphBlockModel).props.textProtection),
  ).toEqual(["fixed", "fixed"]);
  expect(
    units
      .slice(2, 4)
      .map((model) => [
        (model as ListBlockModel).props.type,
        (model as ListBlockModel).props.checked,
      ]),
  ).toEqual([
    ["todo", false],
    ["todo", false],
  ]);
  expect(units[2].text!.toDelta()[0]).toEqual({
    insert: "Ada {{literal}}",
    attributes: { bold: true },
  });
  expect(
    units.every(
      (model) => !("repeat" in model.props) || model.props.repeat === undefined,
    ),
  ).toBe(true);
  expect(new Set(units.map((model) => model.id)).size).toBe(units.length);
  expect(units.every((model) => !source.getModelById(model.id))).toBe(true);
  const table = units[6] as TableBlockModel;
  const rows = Object.values(table.props.rows).sort((a, b) =>
    a.order.localeCompare(b.order),
  );
  expect(rows).toHaveLength(3);
  expect(
    rows.every((row) => row.repeat === undefined && row.rowId !== "r"),
  ).toBe(true);
  expect(Object.keys(table.props.cells).sort()).toEqual(
    rows.flatMap((row) => [`${row.rowId}:name`, `${row.rowId}:email`]).sort(),
  );
  expect(
    rows.map((row) =>
      ["name", "email"].map((column) =>
        table.props.cells[`${row.rowId}:${column}`].text.toString(),
      ),
    ),
  ).toEqual([
    ["Name", "Email"],
    ["Ada {{literal}} ", "ada@example.test"],
    ["Bea ", "bea@example.test"],
  ]);
  const fields = rows
    .slice(1)
    .map((row) =>
      DocumentFieldSchema.parse(
        table.props.cells[`${row.rowId}:name`].text.toDelta().at(-1)?.attributes
          ?.documentField,
      ),
    );
  expect(new Set(fields.map((field) => field.id)).size).toBe(2);
  fields.forEach((field) => {
    expect(field.id).not.toBe("prototype-answer");
    expect(field).toMatchObject({ value: "Initial {{literal}}" });
  });
  expect(
    table.props.cells[`${rows[1].rowId}:name`].text.toDelta()[0].attributes,
  ).toEqual({ italic: true });
  expect(table.props.columns.name.width).toBe(240);
  expect(
    rows.map((row) => table.props.cells[`${row.rowId}:name`].backgroundColor),
  ).toEqual([
    undefined,
    "--myoxus-sem-status-error-paper",
    "--myoxus-sem-status-error-paper",
  ]);
  expect(table.props.headerRows).toBe(1);
  expect(
    rows.map((row) => table.props.cells[`${row.rowId}:name`].textProtection),
  ).toEqual([undefined, "fixed", "fixed"]);
  expect(f.preflight).toHaveBeenCalledOnce();
  expect(f.creationFacts).toHaveBeenCalledOnce();

  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
});

test.each([
  "empty",
  "denied",
  "missing-field",
  "unsupported-source",
  "unbound",
  "children",
  "missing-cell",
  "header-repeat",
])(
  "repeat preflight %s performs no target copy or metadata write",
  async (kind) => {
    const f = setup();
    const source = repeatSource(f);
    if (kind === "empty") f.facts["workspace.members"] = [];
    if (kind === "denied")
      f.preflight.mockRejectedValue(
        new TemplateInstantiationError("member-fetch"),
      );
    if (kind === "missing-field")
      f.facts["workspace.members"] = [{ name: "", email: "a@example.test" }];
    if (kind === "unsupported-source")
      source.updateBlock(f.paragraph("source"), {
        repeat: { source: "unknown", alias: "member" },
      });
    if (kind === "unbound")
      source.updateBlock(f.paragraph("source"), () => {
        Reflect.deleteProperty(f.paragraph("source").props, "repeat");
      });
    if (kind === "children")
      source.addBlock(
        "myoxus:paragraph",
        { text: new Text("Child") },
        f.paragraph("source"),
      );
    if (kind === "missing-cell")
      delete (
        source
          .getAllModels()
          .find((m) => m.flavour === "myoxus:table") as TableBlockModel
      ).props.cells["r:name"];
    if (kind === "header-repeat")
      source.updateBlock(
        source
          .getAllModels()
          .find((m) => m.flavour === "myoxus:table") as TableBlockModel,
        { headerRows: 2 },
      );
    const before = encodeStateAsUpdate(source.spaceDoc);
    await expect(f.apply()).rejects.toMatchObject({
      reason: kind === "denied" ? "member-fetch" : "repeat-invalid",
    });
    expect(f.body()).toBe("Original content");
    expect(f.target.updateProperties).not.toHaveBeenCalled();
    expect(f.creationFacts).not.toHaveBeenCalled();
    expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
  },
);

test("live repeat expansion rejects a header prototype before any mutation", () => {
  const f = setup();
  const source = repeatSource(f);
  const table = source
    .getAllModels()
    .find((model) => model.flavour === "myoxus:table") as TableBlockModel;
  source.updateBlock(table, { headerRows: 2 });
  const before = encodeStateAsUpdate(source.spaceDoc);

  expect(() =>
    expandAndApplyTemplateUnits(
      source,
      {
        "workspace.members": [
          { name: "Creator", email: "creator@example.test" },
        ],
      },
      () => {},
    ),
  ).toThrow();
  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
});

test.each([true, false])(
  "repeat expansion shares late-failure rollback (existing=%s)",
  async (existing) => {
    const f = setup();
    const source = repeatSource(f);
    const before = encodeStateAsUpdate(source.spaceDoc);
    let reachedExpandedTarget = false;
    const failAfterExpansion = (id: string) => {
      const table = f.stores
        .get(id)!
        .getAllModels()
        .find((model) => model.flavour === "myoxus:table") as TableBlockModel;
      reachedExpandedTarget = Object.values(table.props.cells).some(
        (cell) => cell.text.toString() === "Creator",
      );
      throw new Error("metadata write failed");
    };
    f.target.updateProperties.mockImplementationOnce(() => {
      failAfterExpansion("target");
    });
    if (!existing)
      vi.spyOn(f.service, "createDoc").mockImplementation(() => {
        const record = f.createRecord("new-target");
        record.updateProperties.mockImplementationOnce(() => {
          failAfterExpansion("new-target");
        });
        return record as unknown as DocRecord;
      });
    await expect(
      f.service.applyTemplate({
        sourceDocId: "source",
        targetDocId: existing ? "target" : undefined,
        creationContext: {},
        variables: {},
        regionalPreferences: preferences,
      }),
    ).rejects.toMatchObject({ reason: "application-failed" });
    expect(reachedExpandedTarget).toBe(true);
    expect(f.body()).toBe("Original content");
    if (!existing) expect(f.records.get("new-target")!.trash$.value).toBe(true);
    expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
  },
);

test("native body/table/title use authoritative creator/time, preserve split-token marks and literal values without changing source", async () => {
  const f = setup();
  const source = f.stores.get("source")!;
  source.updateBlock(f.paragraph("source"), {
    text: new Text([
      { insert: "Before ", attributes: { italic: true } },
      { insert: "{{creator.", attributes: { bold: true } },
      { insert: "name}}", attributes: { italic: true } },
      { insert: " after", attributes: { italic: true } },
      {
        insert: " ",
        attributes: {
          bold: true,
          documentField: DocumentFieldSchema.parse({
            type: "input",
            id: "body-answer",
            definition: {
              kind: "text",
              label: "Answer",
              required: true,
              default: "Default {{literal}}",
            },
            value: "Source preview answer",
          }),
        },
      },
    ]),
  });
  source.addBlock(
    "myoxus:table",
    {
      rows: { r: { rowId: "r", order: "a0" } },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: {
        "r:c": {
          text: new Text(
            "{{creator.email}} {{document.created_at.date}} {{document.created_at.time}}",
          ),
        },
      },
    },
    source.root!.children[0].id,
  );
  const before = encodeStateAsUpdate(source.spaceDoc);
  await f.apply("{{workspace.name}} {{document.created_at.datetime}}");
  expect(f.body()).toBe("Before Creator after ");
  expect(
    (f.paragraph("target") as unknown as { text: Text }).text.toDelta(),
  ).toEqual([
    { insert: "Before ", attributes: { italic: true } },
    { insert: "Creator", attributes: { bold: true } },
    { insert: " after", attributes: { italic: true } },
    {
      insert: " ",
      attributes: {
        bold: true,
        documentField: DocumentFieldSchema.parse({
          type: "input",
          id: "body-answer",
          definition: {
            kind: "text",
            label: "Answer",
            required: true,
            default: "Default {{literal}}",
          },
          value: "Default {{literal}}",
        }),
      },
    },
  ]);
  const table = f.stores
    .get("target")!
    .getAllModels()
    .find((m) => m.flavour === "myoxus:table")!;
  expect(String((table.props as any).cells["r:c"].text)).toBe(
    "creator@example.test 03.01.2020 00:15",
  );
  expect(f.target.title$.value).toContain("Team {{literal}}");
  expect(f.target.title$.value).toContain("2020");
  expect(f.creationFacts).toHaveBeenCalledOnce();

  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
});

test("the public service preserves an existing title without scanning it and date/workspace-only templates perform no identity IO", async () => {
  const f = setup();
  f.target.changeDocTitle("{{malformed..preserved}}");
  f.setSource("{{workspace.name}} {{date}}");
  await f.instantiate.instantiate("source", {
    creationContext: {},
    targetDocId: "target",
    titlePolicy: "preserve",
    date: "2026-01-02",
    regionalPreferences: preferences,
  });
  expect(f.body()).toBe("Team {{literal}} 02.01.2026");
  expect(f.target.title$.value).toBe("{{malformed..preserved}}");
  expect(f.creationFacts).not.toHaveBeenCalled();
  expect(f.readTemplateValues).toHaveBeenCalledWith(
    ["workspace.name"],
    "target",
    {},
    expect.any(AbortSignal),
    true,
  );
  expect(f.folder).not.toHaveBeenCalled();
  expect(f.folderReady).not.toHaveBeenCalled();
});

test("preserve-title application resolves only after body and properties are persisted", async () => {
  const f = setup();
  let release!: () => void;
  f.waitForDocSynced.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let completed = false;
  const pending = f.instantiate
    .instantiate("source", {
      creationContext: {},
      targetDocId: "target",
      titlePolicy: "preserve",
      date: "2026-01-02",
      regionalPreferences: preferences,
    })
    .then(() => {
      completed = true;
    });

  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(completed).toBe(false);
  expect(f.waitForDocSynced).toHaveBeenCalledWith(
    "target",
    expect.any(AbortSignal),
  );
  release();
  await pending;
  expect(completed).toBe(true);
});

test("organization scalars replace native title, body and table without mutating the source", async () => {
  const f = setup();
  f.setSource("{{organization_name}} / {{organization_unit_name}}");
  const source = f.stores.get("source")!;
  source.addBlock(
    "myoxus:table",
    {
      rows: { r: { rowId: "r", order: "a0" } },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: {
        "r:c": {
          text: new Text("{{organization_unit_name}}: {{organization_name}}"),
        },
      },
    },
    source.root!.children[0].id,
  );
  const before = encodeStateAsUpdate(source.spaceDoc);
  await f.apply("{{organization_name}} · {{organization_unit_name}}");
  expect(f.body()).toBe("Organization / Owner team");
  expect(f.target.title$.value).toBe("Organization · Owner team");
  const table = f.stores
    .get("target")!
    .getAllModels()
    .find((m) => m.flavour === "myoxus:table")!;
  expect(String((table.props as any).cells["r:c"].text)).toBe(
    "Owner team: Organization",
  );
  expect(f.readTemplateValues).toHaveBeenCalledWith(
    ["organization_name", "organization_unit_name"],
    "target",
    {},
    expect.any(AbortSignal),
    true,
  );
  expect(f.preflight).toHaveBeenCalledOnce();
  expect(f.creationFacts).not.toHaveBeenCalled();
  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
});

test.each([
  ["organization_name", "Organization"],
  ["organization_unit_name", "Owner team"],
] as const)(
  "%s resolves independently of the other unavailable field",
  async (token, expected) => {
    const f = setup();
    delete f.facts[
      token === "organization_name"
        ? "organization_unit_name"
        : "organization_name"
    ];
    f.setSource(`{{${token}}}`);
    await f.apply();
    expect(f.body()).toBe(expected);
    expect(f.readTemplateValues).toHaveBeenCalledWith(
      [token],
      "target",
      {},
      expect.any(AbortSignal),
      true,
    );
  },
);

test.each([
  "organization_name",
  "organization_unit_name",
  "folder_name",
  "parent_page_title",
  "actor.name",
  "actor.email",
  "folder.path",
])("reserved %s cannot be supplied even when unused", async (token) => {
  const f = setup();
  await expect(
    f.service.applyTemplate({
      creationContext: {},
      sourceDocId: "source",
      targetDocId: "target",
      variables: { [token]: "forged" },
      regionalPreferences: preferences,
    }),
  ).rejects.toMatchObject({ reason: "invalid-syntax" });
  expect(f.body()).toBe("Original content");
  expect(f.readTemplateValues).not.toHaveBeenCalled();
});

test("actor stays distinct from committed creator and ISO fields share the Journal day", async () => {
  const f = setup();
  f.facts["actor.name"] = "Applying actor";
  f.facts["actor.email"] = "actor@example.test";
  f.facts["creator.name"] = "Original creator";
  f.facts["folder.path"] = "Top/Destination";
  f.setSource(
    "{{actor.name}} {{actor.email}} / {{creator.name}} / {{folder.path}} / {{week}} {{calendar.iso_week_year}}",
  );
  const source = encodeStateAsUpdate(f.stores.get("source")!.spaceDoc);
  await f.instantiate.instantiate("source", {
    creationContext: { folderId: "folder" },
    targetDocId: "target",
    date: "2021-01-01",
    regionalPreferences: { ...preferences, timezone: "Pacific/Kiritimati" },
  });
  expect(f.body()).toBe(
    "Applying actor actor@example.test / Original creator / Top/Destination / 53 2020",
  );
  expect(f.creationFacts).toHaveBeenCalledOnce();
  const late = f.readTemplateValues.mock.calls.filter(
    (call) => call[4] !== true,
  );
  expect(late.flatMap((call) => call[0])).toEqual(["creator.name"]);
  expect(encodeStateAsUpdate(f.stores.get("source")!.spaceDoc)).toEqual(source);
  f.stores.get("target")!.updateBlock(f.paragraph("target"), {
    text: new Text("Edited ordinary output"),
  });
  expect(f.body()).toBe("Edited ordinary output");
});

test.each(["actor.name"])(
  "offline %s is unavailable before creating a target",
  async (path) => {
    const f = setup();
    f.context.serverBacked = false;
    f.setSource(`{{${path}}}`);
    await expect(
      f.service.applyTemplate({
        creationContext: {},
        sourceDocId: "source",
        variables: {},
        regionalPreferences: preferences,
      }),
    ).rejects.toMatchObject({ reason: "local-only-incompatible" });
    expect(f.service.createDoc).not.toHaveBeenCalled();
    expect(f.readTemplateValues).not.toHaveBeenCalled();
  },
);

test("ISO year cannot reconstruct an application day from caller-authored date text", async () => {
  const f = setup();
  f.setSource("{{calendar.iso_week_year}}");
  await expect(
    f.service.applyTemplate({
      creationContext: {},
      sourceDocId: "source",
      variables: { iso: "2021-01-01", week: "53" },
      regionalPreferences: preferences,
    }),
  ).rejects.toMatchObject({ reason: "metadata-unavailable" });
  expect(f.service.createDoc).not.toHaveBeenCalled();
  expect(f.readTemplateValues).not.toHaveBeenCalled();
});

test.each([undefined, "   "])(
  "unavailable actor value %s cannot become pending creation data",
  async (value) => {
    const f = setup();
    f.setSource("{{actor.name}}");
    f.readTemplateValues.mockResolvedValue({
      "actor.name": value,
    } as unknown as TemplateVariables);
    await expect(
      f.service.applyTemplate({
        creationContext: {},
        sourceDocId: "source",
        variables: {},
        regionalPreferences: preferences,
      }),
    ).rejects.toMatchObject({
      reason: value === "   " ? "empty-field" : "metadata-unavailable",
    });
    expect(f.service.createDoc).not.toHaveBeenCalled();
    expect(f.body("source")).toBe("{{actor.name}}");
  },
);

test("title policy and native content capture the same source revision after loading", async () => {
  const f = setup();
  let release!: () => void;
  f.source.waitForSyncReady.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const pending = f.instantiate.instantiate("source", {
    creationContext: {},
    targetDocId: "target",
    date: "2026-01-02",
    regionalPreferences: preferences,
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.source.changeDocTitle("Loaded {{workspace.name}}");
  f.setSource("Loaded body {{workspace.name}}");
  release();
  await pending;
  expect(f.target.title$.value).toBe("Loaded Team {{literal}}");
  expect(f.body()).toBe("Loaded body Team {{literal}}");
});

test("the initial template-state lookup shares the forward deadline", async () => {
  vi.useFakeTimers();
  const f = setup();
  f.isTemplate.mockReturnValueOnce(new Promise<boolean>(() => {}));
  const apply = vi.spyOn(f.service, "applyTemplate");

  const pending = f.instantiate.instantiate("source", {
    creationContext: {},
    targetDocId: "target",
    date: "2026-01-02",
    regionalPreferences: preferences,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    reason: "sync-timeout",
  });
  await vi.advanceTimersByTimeAsync(30_000);

  await rejected;
  expect(apply).not.toHaveBeenCalled();
});

test.each(["organization_name", "organization_unit_name"])(
  "unavailable or empty %s aborts without changing existing content",
  async (token) => {
    const f = setup();
    f.setSource(`{{${token}}}`);
    const before = encodeStateAsUpdate(f.stores.get("target")!.spaceDoc);
    for (const value of [null, "   "]) {
      f.preflight.mockRejectedValue(
        new TemplateInstantiationError(
          token === "organization_name"
            ? "organization-unavailable"
            : "owner-unit-unavailable",
          { cause: value },
        ),
      );
      await expect(f.apply()).rejects.toMatchObject({
        reason:
          token === "organization_name"
            ? "organization-unavailable"
            : "owner-unit-unavailable",
      });
      expect(encodeStateAsUpdate(f.stores.get("target")!.spaceDoc)).toEqual(
        before,
      );
      expect(f.body()).toBe("Original content");
    }
  },
);

test.each([true, false])(
  "organization substitution shares rollback after late metadata failure (existing=%s)",
  async (existing) => {
    const f = setup();
    f.setSource("{{organization_name}} {{creator.name}}");
    f.creationFacts.mockRejectedValue(
      new TemplateInstantiationError("member-fetch", {
        cause: new Error("private upstream failure"),
      }),
    );
    await expect(
      f.service.applyTemplate({
        creationContext: {},
        sourceDocId: "source",
        targetDocId: existing ? "target" : undefined,
        variables: {},
        regionalPreferences: preferences,
      }),
    ).rejects.toMatchObject({ reason: "member-fetch" });
    expect(f.preflight).toHaveBeenCalledOnce();
    if (existing) {
      expect(f.body()).toBe("Original content");
      expect(f.target.title$.value).toBe("target");
    } else {
      expect(f.records.get("new-target")!.trash$.value).toBe(true);
    }
    expect(f.body("source")).toBe("{{organization_name}} {{creator.name}}");
  },
);

test("explicit creation context fills native title/body/table without changing its source", async () => {
  const f = setup();
  f.createRecord("parent");
  f.setSource("{{parent_page_title}} / {{folder_name}}");
  const source = f.stores.get("source")!;
  source.addBlock(
    "myoxus:table",
    {
      rows: { r: { rowId: "r", order: "a0" } },
      columns: { c: { columnId: "c", order: "a0" } },
      cells: {
        "r:c": { text: new Text("{{folder_name}}: {{parent_page_title}}") },
      },
    },
    source.root!.children[0].id,
  );
  const before = encodeStateAsUpdate(source.spaceDoc);
  await f.apply("{{parent_page_title}} · {{folder_name}}", "target", {
    parentDocId: "parent",
    folderId: "folder",
  });
  expect(f.body()).toBe("Current parent / Destination");
  expect(f.target.title$.value).toBe("Current parent · Destination");
  const table = f.stores
    .get("target")!
    .getAllModels()
    .find((m) => m.flavour === "myoxus:table")!;
  expect(String((table.props as any).cells["r:c"].text)).toBe(
    "Destination: Current parent",
  );
  expect(f.readTemplateValues).toHaveBeenCalledWith(
    ["folder_name", "parent_page_title"],
    "target",
    { parentDocId: "parent", folderId: "folder" },
    expect.any(AbortSignal),
    true,
  );
  expect(f.folder).not.toHaveBeenCalled();
  expect(f.folderReady).not.toHaveBeenCalled();
  expect(f.creationFacts).not.toHaveBeenCalled();
  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
});

test.each([
  "missing",
  "source",
  "target",
  "foreign",
  "trash",
  "denied",
  "empty",
])("invalid explicit parent (%s) never changes the target", async (kind) => {
  const f = setup();
  const parent = f.createRecord("parent");
  f.setSource("{{parent_page_title}}");
  if (kind === "trash") parent.meta$.setValue({ title: "Parent", trash: true });
  if (["denied", "empty"].includes(kind))
    f.preflight.mockRejectedValue(
      new TemplateInstantiationError("parent-unavailable"),
    );
  const parentDocId =
    kind === "missing"
      ? undefined
      : ["source", "target", "foreign"].includes(kind)
        ? kind
        : "parent";
  const before = encodeStateAsUpdate(f.stores.get("target")!.spaceDoc);
  await expect(
    f.apply(undefined, "target", { parentDocId }),
  ).rejects.toMatchObject({ reason: "parent-unavailable" });
  expect(f.body()).toBe("Original content");
  expect(encodeStateAsUpdate(f.stores.get("target")!.spaceDoc)).toEqual(before);
  if (!["denied", "empty"].includes(kind))
    expect(f.readTemplateValues).not.toHaveBeenCalled();
});

test.each(["absent", "ambiguous"] as const)(
  "folder %s is typed and preserves the target",
  async (status) => {
    const f = setup();
    f.preflight.mockRejectedValue(
      new TemplateInstantiationError(`folder-${status}`),
    );
    f.setSource("{{folder_name}} {{folder.path}}");
    await expect(f.apply()).rejects.toMatchObject({
      reason: `folder-${status}`,
    });
    expect(f.body()).toBe("Original content");
    expect(f.creationFacts).not.toHaveBeenCalled();
  },
);

test.each([true, false])(
  "creation context shares late-failure rollback (existing=%s)",
  async (existing) => {
    const f = setup();
    f.createRecord("parent");
    f.setSource("{{parent_page_title}} {{folder_name}} {{creator.name}}");
    f.creationFacts.mockRejectedValue(
      new TemplateInstantiationError("member-fetch", {
        cause: new Error("private provider detail"),
      }),
    );
    await expect(
      f.service.applyTemplate({
        sourceDocId: "source",
        targetDocId: existing ? "target" : undefined,
        creationContext: { parentDocId: "parent", folderId: "folder" },
        variables: {},
        regionalPreferences: preferences,
      }),
    ).rejects.toMatchObject({ reason: "member-fetch" });
    expect(f.preflight).toHaveBeenCalledOnce();
    expect(f.readTemplateValues.mock.calls[0][2]).toEqual({
      parentDocId: "parent",
      folderId: "folder",
    });
    expect(f.folder).not.toHaveBeenCalled();
    if (existing) {
      expect(f.body()).toBe("Original content");
      expect(f.target.title$.value).toBe("target");
    } else expect(f.records.get("new-target")!.trash$.value).toBe(true);
    expect(f.body("source")).toBe(
      "{{parent_page_title}} {{folder_name}} {{creator.name}}",
    );
  },
);

test("creation-time-only resolution does not require member permission", async () => {
  const f = setup();
  f.setSource(
    "{{document.created_at.date}} {{document.created_at.time}} {{document.created_at.datetime}}",
  );
  await f.apply();
  expect(f.body()).toContain("03.01.2020 00:15");
  expect(f.creationFacts).toHaveBeenCalledOnce();
  expect(
    f.readTemplateValues.mock.calls.every((call) =>
      call[0].every((path) => path.startsWith("document.created_at.")),
    ),
  ).toBe(true);
});

test.each(["creator.name", "creator.email"])(
  "creator field %s does not require the other field",
  async (path) => {
    const f = setup();
    f.setSource(`{{${path}}}`);
    f.facts[path] = path === "creator.name" ? "Name" : "address@example.test";
    delete f.facts[path === "creator.name" ? "creator.email" : "creator.name"];
    await f.apply();
    expect(f.body()).toBe(
      path === "creator.name" ? "Name" : "address@example.test",
    );
  },
);

test.each(["local", "empty-workspace", "syntax", "unknown", "building-block"])(
  "preflight %s preserves the original target",
  async (kind) => {
    const f = setup();
    if (kind === "local") {
      f.context.serverBacked = false;
      f.setSource("{{creator.name}}");
    }
    if (kind === "empty-workspace")
      f.preflight.mockRejectedValue(
        new TemplateInstantiationError("empty-field"),
      );
    if (kind === "syntax") f.setSource("{{creator..name}}");
    if (kind === "unknown") f.setSource("{{unknown}}");
    if (kind === "unknown")
      f.preflight.mockRejectedValue(
        new TemplateInstantiationError("unresolved-variable"),
      );
    if (kind === "building-block")
      vi.spyOn(
        f.templateDocService,
        "resolveSourceMetadataForDoc",
      ).mockResolvedValue(
        customSourceMetadata("source", {
          category: "building-blocks",
          tags: [],
        }),
      );
    await expect(f.apply()).rejects.toBeDefined();
    expect(f.body()).toBe("Original content");
    expect(f.creationFacts).not.toHaveBeenCalled();
    expect(f.source.release).toHaveBeenCalledOnce();
    expect(f.target.release).toHaveBeenCalledOnce();
  },
);

test("source-equals-target is rejected before opening or copying", async () => {
  const f = setup();
  await expect(
    f.service.applyTemplate({
      creationContext: {},
      sourceDocId: "source",
      targetDocId: "source",
      variables: {},
      regionalPreferences: preferences,
    }),
  ).rejects.toMatchObject({ reason: "source-is-target" });
  expect(f.service.open).not.toHaveBeenCalled();
});

test.each(["denied", "syntax", "repeat", "building-block"])(
  "new target preflight %s creates no leaf and releases only the source",
  async (kind) => {
    const f = setup();
    if (kind === "denied")
      f.preflight.mockRejectedValue(
        new TemplateInstantiationError("member-fetch"),
      );
    if (kind === "syntax") f.setSource("{{bad..name}}");
    if (kind === "repeat") {
      repeatSource(f);
      f.facts["workspace.members"] = [];
    }
    if (kind === "building-block")
      vi.spyOn(
        f.templateDocService,
        "resolveSourceMetadataForDoc",
      ).mockResolvedValue(
        customSourceMetadata("source", {
          category: "building-blocks",
          tags: [],
        }),
      );
    await expect(
      f.service.applyTemplate({
        sourceDocId: "source",
        creationContext: {},
        variables: {},
        regionalPreferences: preferences,
      }),
    ).rejects.toBeDefined();
    expect(f.service.createDoc).not.toHaveBeenCalled();
    expect(f.records.has("new-target")).toBe(false);
    expect(f.creationFacts).not.toHaveBeenCalled();
    expect(f.source.release).toHaveBeenCalledOnce();
    expect(f.target.release).not.toHaveBeenCalled();
  },
);

test("local workspace/date and folder resolution retains its native owner without server queries", async () => {
  const f = setup();
  f.context.serverBacked = false;
  f.setSource("{{workspace.name}} {{date}} {{folder_name}} {{folder.path}}");
  await f.apply(undefined, "target", { folderId: "folder" });
  expect(f.body()).toBe(
    "Team {{literal}} Legacy date Destination Root/Destination",
  );
  expect(f.folder).toHaveBeenCalledWith("target", "folder", "workspace");
  expect(f.folderReady).toHaveBeenCalledWith(
    "db$folders",
    expect.any(AbortSignal),
  );
  expect(f.readTemplateValues).not.toHaveBeenCalled();
});

test.each(["missing-owner", "missing-time", "member-denied", "empty-field"])(
  "post-copy %s restores existing content and leaves source intact",
  async (kind) => {
    const f = setup();
    f.setSource("{{creator.email}} {{document.created_at.time}}");
    if (kind === "missing-owner")
      f.creationFacts.mockRejectedValue(
        new TemplateInstantiationError("creator-unavailable"),
      );
    if (kind === "missing-time")
      f.facts["document.created_at.time"] = "invalid";
    if (kind === "member-denied")
      f.creationFacts.mockRejectedValue(
        new TemplateInstantiationError("member-fetch", {
          cause: new Error("private provider detail"),
        }),
      );
    if (kind === "empty-field")
      f.creationFacts.mockRejectedValue(
        new TemplateInstantiationError("empty-field"),
      );
    await expect(f.apply("New title")).rejects.toBeDefined();
    expect(f.body()).toBe("Original content");
    expect(f.target.title$.value).toBe("target");
    expect(f.target.properties$.value).toEqual({
      id: "target",
      "custom:fixture": "target",
    });
    expect(f.body("source")).toBe(
      "{{creator.email}} {{document.created_at.time}}",
    );
  },
);

test("a failed new target is trashed rather than exposed as a successful application", async () => {
  const f = setup();
  f.setSource("{{creator.name}}");
  f.creationFacts.mockRejectedValue(
    new TemplateInstantiationError("member-fetch"),
  );
  await expect(
    f.service.applyTemplate({
      creationContext: {},
      sourceDocId: "source",
      variables: {},
      regionalPreferences: preferences,
    }),
  ).rejects.toMatchObject({ reason: "member-fetch" });
  expect(f.records.get("new-target")!.trash$.value).toBe(true);
});

test("late title failure restores title, properties and native content; failed compensation remains distinguishable", async () => {
  const f = setup();
  f.stores
    .get("source")!
    .updateBlock(f.paragraph("source"), { textProtection: "source" });
  f.target.changeDocTitle.mockImplementationOnce((title) => {
    f.target.meta$.setValue({ ...f.target.meta$.value, title });
    throw new Error("write failed");
  });
  await expect(f.apply("Replacement")).rejects.toMatchObject({
    reason: "application-failed",
  });
  expect(f.target.title$.value).toBe("target");
  expect(f.body()).toBe("Original content");
  expect(f.target.properties$.value).toEqual({
    id: "target",
    "custom:fixture": "target",
  });
  f.target.updateProperties.mockImplementation(() => {
    throw new Error("store unavailable");
  });
  await expect(f.apply()).rejects.toMatchObject({ reason: "rollback-failed" });
});

test.each(["conflict", "dispose", "timeout"])(
  "pending identity resolution handles %s and releases both references",
  async (kind) => {
    const f = setup();
    f.setSource("{{creator.name}}");
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.creationFacts.mockImplementation(async () => {
      started();
      return new Promise(() => {});
    });
    if (kind === "timeout") vi.useFakeTimers();
    const pending = f.apply();
    const failed = expect(pending).rejects.toMatchObject({
      reason:
        kind === "dispose"
          ? "cancelled"
          : kind === "timeout"
            ? "sync-timeout"
            : "conflict",
    });
    await resolving;
    if (kind === "conflict")
      f.stores.get("target")!.updateBlock(f.paragraph("target"), {
        text: new Text("Collaborator's edit"),
      });
    if (kind === "dispose") f.service.dispose();
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(f.body()).toBe(
      kind === "conflict" ? "Collaborator's edit" : "Original content",
    );
    expect(f.target.release).toHaveBeenCalledOnce();
    expect(f.source.release).toHaveBeenCalledOnce();
  },
);

test("check consumes native title, text and cell diagnostics without any writes, including readonly sources", async () => {
  const f = setup();
  const store = f.stores.get("source")!;
  store.updateBlock(store.root!, {
    title: new Text("{{unknown.title}} source"),
  });
  f.setSource(
    "{{workspace.name}} {{input.project}} {{creator.name}} {{folder.path}} {{unknown.body}}",
  );
  const tableId = store.addBlock(
    "myoxus:table",
    {
      rows: { row: { rowId: "row", order: "a0" } },
      columns: { column: { columnId: "column", order: "a0", width: 100 } },
      cells: { "row:column": { text: new Text("{{unknown.cell}}") } },
    },
    store.root!.children[0],
  );
  const fieldText = f.paragraph("source").text!;
  fieldText.insert(" ", fieldText.length, {
    documentField: DocumentFieldSchema.parse({
      type: "input",
      id: "unfinished",
      definition: { kind: "text", label: "Question", required: true },
      value: null,
    }),
  });
  fieldText.insert(" ", fieldText.length, {
    documentField: DocumentFieldSchema.parse({
      type: "metadata",
      id: "target-metadata",
      key: "responsible",
      format: "name",
    }),
  });
  const cell = (store.getModelById(tableId) as TableBlockModel).props.cells[
    "row:column"
  ].text;
  cell.insert(" ", cell.length, {
    documentField: DocumentFieldSchema.parse({
      type: "input",
      id: "invalid-date",
      definition: { kind: "date", label: "Deadline", required: false },
      value: "2026-02-30",
    }),
  });
  store.readonly = true;
  const before = encodeStateAsUpdate(store.spaceDoc);
  const ids = [...f.stores.keys()];
  const result = await f.service.checkTemplate(
    "source",
    new AbortController().signal,
  );
  cleanup.push(result.release);
  const find = (name: string) =>
    result.diagnostics.find((d) => d.name === name)!;
  expect(find("unknown.title")).toMatchObject({
    kind: "title",
    blockId: store.root!.id,
    start: 0,
    length: 17,
    status: "error",
    reason: "unknown-token",
  });
  expect(find("unknown.body")).toMatchObject({
    kind: "text",
    blockId: f.paragraph("source").id,
    reason: "unknown-token",
  });
  expect(find("unknown.cell")).toMatchObject({
    kind: "cell",
    blockId: tableId,
    rowId: "row",
    columnId: "column",
    reason: "unknown-token",
  });
  expect(find("input.project").status).toBe("input");
  expect(find("creator.name").status).toBe("application");
  expect(find("folder.path")).toMatchObject({
    status: "context",
    reason: "folder-absent",
  });
  expect(find("workspace.name").status).toBe("available");
  expect(
    result.nativeFields.map((field) => [
      field.field?.id,
      field.state,
      field.complete,
    ]),
  ).toEqual([
    ["unfinished", "input-unset", false],
    ["target-metadata", "metadata", true],
    ["invalid-date", "invalid", false],
  ]);
  expect(result.nativeFields[2]).toMatchObject({
    blockId: tableId,
    kind: "cell",
    rowId: "row",
    columnId: "column",
  });
  expect(encodeStateAsUpdate(store.spaceDoc)).toEqual(before);
  expect([...f.stores.keys()]).toEqual(ids);
  expect(f.setDocTemplateStateSetting).not.toHaveBeenCalled();
  expect(f.waitForCreateAcknowledgement).not.toHaveBeenCalled();
  expect(f.records.get("source")!.updateProperties).not.toHaveBeenCalled();
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.readTemplateValues).not.toHaveBeenCalled();
});

test("check rejects snapshot positions after an edit during fact resolution, and deliberate recheck captures the correction", async () => {
  const f = setup();
  f.setSource("{{actor.name}} {{unknown.path}}");
  let finish!: () => void;
  f.creationFacts.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.checkTemplate(
    "source",
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.creationFacts).toHaveBeenCalled());
  f.setSource("{{workspace.name}}");
  finish();
  const result = await pending;
  cleanup.push(result.release);
  expect(result.diagnostics.some((d) => d.reason === "unknown-token")).toBe(
    true,
  );
  expect(result.stale$.value).toBe(true);
  expect(result.isCurrent()).toBe(false);
  const checked = await f.service.checkTemplate(
    "source",
    new AbortController().signal,
  );
  cleanup.push(checked.release);
  expect(checked.isCurrent()).toBe(true);
  expect(checked.diagnostics.map((d) => [d.name, d.status])).toEqual([
    ["workspace.name", "available"],
  ]);
  f.setSource("");
  expect(checked.isCurrent()).toBe(false);
});

test("native template application regenerates editor IDs and retains the same Task reference without copying SQL source state", async () => {
  const workspaceId = "07b4325f-c8ba-44b2-a9aa-4575bd5a3bd6";
  const f = setup(workspaceId);
  const source = f.stores.get("source")!;
  const note = source.getBlocksByFlavour("myoxus:note")[0].model;
  const identity = {
    serverWorkspaceId: workspaceId,
    serverDatabaseId: "779cb334-7997-4047-90e1-71c23dd095d8",
    serverRowId: "e812080f-e010-4aab-8207-7ad45bd4acbb",
  };
  const originalId = source.addBlock("myoxus:database", identity, note);
  const wholeDatabase = {
    serverDatabaseId: identity.serverDatabaseId,
    serverViewId: "9dd949a4-1fd1-46fb-a228-40e942dc1209",
  };
  source.addBlock("myoxus:database", wholeDatabase, note);
  const original = encodeStateAsUpdate(source.spaceDoc);

  await f.apply();

  const references = f.stores
    .get("target")!
    .getBlocksByFlavour("myoxus:database");
  expect(references).toHaveLength(2);
  expect(references[1].model.props).toMatchObject({
    ...wholeDatabase,
    serverRowId: undefined,
    serverWorkspaceId: undefined,
  });
  expect(references[0].model.id).not.toBe(originalId);
  expect(references[0].model.props).toMatchObject({
    ...identity,
    serverViewId: null,
  });
  using transformer = f.stores.get("target")!.getTransformer();
  const persisted = transformer.sliceToSnapshot(
    Slice.fromModels(f.stores.get("target")!, [references[0].model]),
  );
  // Reactive accessor keys belong to the live model, not the persisted payload.
  expect(persisted?.content[0].props).toEqual({
    ...identity,
    serverViewId: null,
  });
  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(original);
  expect(f.service.createDoc).not.toHaveBeenCalled();
});

test("manual inputs use one captured source, literal answers and a human-safe deadline", async () => {
  vi.useFakeTimers();
  const f = setup();
  f.source.changeDocTitle("Brief {{input.project}} · {{input.date.meeting}}");
  f.setSource(
    "{{input.project}} / {{input.reference}} / {{input.project}} / {{date}} / {{input.datetime.next_meeting}}",
  );
  let respond!: (values: Readonly<Record<string, string>>) => void;
  const requestInputs = vi.fn(
    (_names: readonly string[]) =>
      new Promise<Readonly<Record<string, string>>>((resolve) => {
        respond = resolve;
      }),
  );
  const pending = f.instantiate.instantiate("source", {
    creationContext: {},
    date: "2026-09-05",
    regionalPreferences: preferences,
    targetDocId: "target",
    titlePolicy: "template",
    requestInputs,
  });
  await vi.waitFor(() => expect(requestInputs).toHaveBeenCalledOnce());
  expect(requestInputs.mock.calls[0][0]).toEqual([
    "input.datetime.next_meeting",
    "input.project",
    "input.reference",
    "input.date.meeting",
  ]);
  expect(f.body()).not.toContain("Brief");
  // An edit while the form is open cannot change which source receives answers.
  f.setSource("Changed source {{input.different}}");
  respond({
    "input.project": "  Atlas {{date}}  ",
    "input.reference": "R-1",
    "input.date.meeting": "2026-12-31",
    "input.datetime.next_meeting": "2026-12-31 23:45:00",
  });
  await pending;
  expect(f.target.title$.value).toBe("Brief Atlas {{date}} · 31.12.2026");
  expect(f.body()).toContain("Atlas {{date}} / R-1 / Atlas {{date}}");
  expect(f.body()).toContain("31.12.2026, 23:45");
  expect(f.body("source")).toBe("Changed source {{input.different}}");
  vi.useRealTimers();
});

test("missing or cancelled manual input creates nothing", async () => {
  const f = setup();
  f.setSource("{{project.goal}} {{input.project}}");
  const options = {
    creationContext: {},
    date: "2026-09-05",
    regionalPreferences: preferences,
  };
  await expect(
    f.instantiate.instantiate("source", options),
  ).rejects.toMatchObject({ reason: "unresolved-variable" });
  expect(f.service.createDoc).not.toHaveBeenCalled();
  await expect(
    f.instantiate.instantiate("source", {
      ...options,
      requestInputs: async () => {
        throw new TemplateInstantiationError("cancelled");
      },
    }),
  ).rejects.toMatchObject({ reason: "cancelled" });
  expect(f.service.createDoc).not.toHaveBeenCalled();
});

test("Journal setting accepts static bodies and preserves the prior choice on required input", async () => {
  const f = setup();
  f.source.changeDocTitle("Ignored {{input.title_only}}");
  f.setSource("Ordinary {{workspace.name}} text");
  await f.instantiate.updateJournalDefault("source");
  expect(f.setJournalTemplate).toHaveBeenCalledExactlyOnceWith("source");
  f.setSource("Required {{input.recipient}}");
  await expect(
    f.instantiate.updateJournalDefault("source"),
  ).rejects.toMatchObject({ reason: "invalid-syntax" });
  expect(f.setJournalTemplate).toHaveBeenCalledOnce();
  expect(f.service.createDoc).not.toHaveBeenCalled();
});

test.each(["page", "journal", "registry"] as const)(
  "classification preserves an incompatible %s source until its use is removed",
  async (use) => {
    const f = setup();
    const setting = f.templateDocService.setting;
    const selection =
      use === "page"
        ? setting.pageTemplateDocId$
        : setting.journalTemplateDocId$;
    const sourceMetadata = customSourceMetadata("source", undefined);
    if (use === "registry") {
      vi.spyOn(
        f.templateDocService,
        "resolveSourceMetadataForDoc",
      ).mockResolvedValue({ ...sourceMetadata, source: "bundle" });
    } else {
      selection.setValue("source");
    }

    await expect(
      f.service.setTemplateClassification("source", "building-blocks", [
        "projects",
      ]),
    ).rejects.toMatchObject({
      reason: use === "registry" ? "managed-source" : "default-in-use",
    });
    expect(f.setDocTemplateClassification).not.toHaveBeenCalled();
    if (use !== "registry") {
      expect(selection.value).toBe("source");
      selection.setValue(undefined);
      await f.service.setTemplateClassification("source", "building-blocks", [
        "projects",
      ]);
      expect(f.setDocTemplateClassification).toHaveBeenCalledExactlyOnceWith(
        "source",
        "building-blocks",
        ["projects"],
      );
      expect(
        f.templateDocService.invalidateTemplateSuggestions,
      ).toHaveBeenCalledOnce();
    }
  },
);

test("guarded Project scalar application preserves explicit empty values and never evaluates inserted braces", async () => {
  const f = setup();
  f.setSource(
    "{{project.title}} / {{project.goal}} / {{project.scope}} / {{project.start_date}} / {{project.end_date}} / {{project.people}}",
  );
  const before = encodeStateAsUpdate(f.stores.get("source")!.spaceDoc);
  await f.service.applyTemplate({
    sourceDocId: "source",
    targetDocId: "target",
    creationContext: {},
    variables: {
      "project.title": "Atlas {{project.goal}}",
      "project.goal": "",
      "project.scope": "A bounded scope",
      "project.start_date": "2026-07-15",
      "project.end_date": "",
      "project.people": "Ada, Lin",
    },
    regionalPreferences: preferences,
  });
  expect(f.body()).toBe(
    "Atlas {{project.goal}} /  / A bounded scope / 2026-07-15 /  / Ada, Lin",
  );
  expect(encodeStateAsUpdate(f.stores.get("source")!.spaceDoc)).toEqual(before);
  expect(f.readTemplateValues.mock.calls.flatMap(([names]) => names)).toEqual(
    [],
  );
});

test("optional Project context does not admit unknown keys or bypass mandatory input prompts", async () => {
  const f = setup();
  const originalTarget = f.body();
  for (const token of [
    "project.unknown",
    "input.project",
    "preparation.unknown",
    "input.preparation",
  ]) {
    f.setSource(`{{project.goal}} / {{${token}}}`);
    const checked = await f.service.checkTemplate(
      "source",
      new AbortController().signal,
    );
    cleanup.push(checked.release);
    expect(
      checked.diagnostics.find((diagnostic) => diagnostic.name === token),
    ).toMatchObject(
      token.startsWith("input.")
        ? { status: "input" }
        : { status: "error", reason: "unknown-token" },
    );
    checked.release();
    await expect(f.apply("Manual brief")).rejects.toMatchObject({
      reason: "unresolved-variable",
    });
    expect(f.body()).toBe(originalTarget);
    expect(f.service.createDoc).not.toHaveBeenCalled();
  }
});

test("ordinary native Library application removes only optional unbound slots and preserves bound Task references", async () => {
  const workspaceId = "07b4325f-c8ba-44b2-a9aa-4575bd5a3bd6";
  const f = setup(workspaceId);
  const source = f.stores.get("source")!;
  const note = source.getBlocksByFlavour("myoxus:note")[0].model;
  for (const [key, kind] of [
    ["context.container", "database"],
    ["context.task", "task"],
  ]) {
    source.addBlock(
      "myoxus:database",
      {
        templateReference: { key, kind, optional: true },
        serverReferencePresentation: "compact",
      },
      note,
    );
  }
  const bound = {
    serverWorkspaceId: workspaceId,
    serverDatabaseId: "779cb334-7997-4047-90e1-71c23dd095d8",
    serverRowId: "e812080f-e010-4aab-8207-7ad45bd4acbb",
    serverReferencePresentation: "compact",
  };
  source.addBlock("myoxus:database", bound, note);
  const before = encodeStateAsUpdate(source.spaceDoc);
  const originalModels = source.getAllModels().length;
  await f.apply();
  const target = f.stores.get("target")!;
  const references = target.getBlocksByFlavour("myoxus:database");
  expect(references).toHaveLength(1);
  expect(references[0].model.props).toMatchObject(bound);
  expect(
    Reflect.get(references[0].model.props, "templateReference"),
  ).toBeUndefined();
  expect(target.getAllModels()).toHaveLength(originalModels - 2);
  expect(f.body()).toBe("Team {{literal}}");
  expect(encodeStateAsUpdate(source.spaceDoc)).toEqual(before);
  expect(f.service.createDoc).not.toHaveBeenCalled();
  expect(f.readTemplateValues.mock.calls.flatMap(([names]) => names)).toEqual([
    "workspace.name",
  ]);
});
