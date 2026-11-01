import type { Store } from "@virgultum/editor/store";
import { Framework, LiveData } from "@myoxus/infra";
import { TestWorkspace } from "@virgultum/store/test";
import { SurfaceBlockSchemaExtension } from "@virgultum/editor/blocks/surface";
import {
  BpmnBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  type BpmnBlockModel,
} from "@virgultum/editor/model";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { initDocFromProps } from "../../../editor/initialization";
import { commitBpmnSourceRevision } from "@virgultum/block-bpmn";
import {
  hasInitializedDiagramContent,
  MermaidDiagramsService,
} from "./mermaid-diagrams";
import {
  initializeBpmnDocument,
  prepareBpmnInitialization,
} from "./bpmn-initialization";
import { DocsService } from "../../doc";
import { MermaidDiagramsStore } from "../store/mermaid-diagrams";
import { WorkspaceService } from "../../workspace";
import { createBlankBpmnSource } from "@myoxus/bpmn-editor/source";
import { prepareBpmnImport, runBpmnImport } from "./bpmn-import";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function nativeDoc(update?: Uint8Array, id?: string) {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  const leaf = workspace.createDoc(id);
  const store = leaf.getStore({
    extensions: [
      RootBlockSchemaExtension,
      SurfaceBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      BpmnBlockSchemaExtension,
    ],
  });
  if (update) {
    store.load();
    Y.applyUpdate(store.spaceDoc, update);
  }
  cleanups.push(() => {
    store.dispose();
    leaf.dispose();
    workspace.dispose();
    workspace.doc.destroy();
  });
  return store;
}

function catalogFixture() {
  const pages = new Map<string, Store>();
  const firstUpdates = new Map<string, Uint8Array>();
  const setPrimaryMode = vi.fn(async () => {});
  const records = new Map<
    string,
    {
      id: string;
      title$: LiveData<string>;
      meta$: LiveData<{ title: string; diagramFormat?: "bpmn" | "mermaid" }>;
      trash$: LiveData<boolean>;
      setPrimaryMode: typeof setPrimaryMode;
    }
  >();
  const saved = vi.fn(async (_id: string, _update: Uint8Array) => {});
  const setDiagramDocKind = vi.fn(async () => {});
  const provision = vi.fn(
    async (options: Parameters<DocsService["createProvisionedDoc"]>[0]) => {
      const doc = nativeDoc(undefined, options!.id);
      pages.set(doc.id, doc);
      doc.spaceDoc.once("update", (update) => firstUpdates.set(doc.id, update));
      initDocFromProps(doc, options?.docProps, options);
      expect(doc.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(1);
      expect(doc.getBlocksByFlavour("myoxus:paragraph")).toHaveLength(0);
      const record = {
        id: doc.id,
        title$: new LiveData(options?.title ?? ""),
        meta$: new LiveData<{
          title: string;
          diagramFormat?: "bpmn" | "mermaid";
        }>({ title: options?.title ?? "", diagramFormat: "bpmn" }),
        trash$: new LiveData(false),
        setPrimaryMode,
      };
      records.set(doc.id, record);
      return record;
    },
  );
  const docs = {
    createProvisionedDoc: provision,
    list: { doc$: (id: string) => new LiveData(records.get(id)) },
    open: (id: string) => {
      const page = pages.get(id);
      return page
        ? {
            doc: {
              virgultumDoc: page,
              yDoc: page.spaceDoc,
              waitForSyncReady: async () => {},
            },
            release: () => {},
          }
        : null;
    },
  } as unknown as DocsService;
  const reopen = () => {
    const framework = new Framework();
    framework.store(MermaidDiagramsStore, {
      setDiagramDocKind,
      isDiagramDoc: () => true,
    } as unknown as MermaidDiagramsStore);
    framework.service(DocsService, docs);
    framework.service(WorkspaceService, {
      workspace: {
        flavour: "local",
        engine: { doc: { saveCapturedUpdateAndWaitForSaved: saved } },
      },
    } as unknown as WorkspaceService);
    framework.service(MermaidDiagramsService, [
      MermaidDiagramsStore,
      DocsService,
      WorkspaceService,
    ]);
    const provider = framework.provider();
    cleanups.push(() => provider.dispose());
    return provider.get(MermaidDiagramsService);
  };
  return {
    service: reopen(),
    reopen,
    pages,
    firstUpdates,
    setPrimaryMode,
    setDiagramDocKind,
    provision,
    saved,
    records,
  };
}

test("BPMN catalog content exists before provisioning acknowledgement without mounting an editor", async () => {
  const fixture = catalogFixture();
  const pending = fixture.service.createDiagram({
    format: "bpmn",
    type: "bpmn",
    title: "Catalog BPMN",
  });
  expect(
    fixture.service.createDiagram({
      format: "bpmn",
      type: "bpmn",
      title: "Duplicate submit",
    }),
  ).toBe(pending);
  const result = await pending;
  expect(result.status).toBe("ready");
  expect(fixture.setPrimaryMode).toHaveBeenCalledWith("edgeless");
  expect(fixture.setDiagramDocKind).toHaveBeenCalledWith(
    result.docId,
    "bpmn",
    "bpmn",
  );
  const firstLeaf = new Y.Doc();
  try {
    Y.applyUpdate(firstLeaf, fixture.firstUpdates.get(result.docId)!);
    expect(
      [...firstLeaf.getMap<Y.Map<unknown>>("blocks").values()].map((block) =>
        block.get("sys:flavour"),
      ),
    ).toEqual(["myoxus:page", "myoxus:surface", "myoxus:note", "myoxus:bpmn"]);
  } finally {
    firstLeaf.destroy();
  }
  const persisted = new Y.Doc();
  try {
    Y.applyUpdate(persisted, fixture.saved.mock.calls[0][1]);
    expect(persisted.getMap("blocks").size).toBe(4);
  } finally {
    persisted.destroy();
  }
});

test("failed diagram creation retries the same persisted source after losing its process-local intent", async () => {
  const fixture = catalogFixture();
  fixture.setPrimaryMode.mockRejectedValueOnce(
    new Error("metadata unavailable"),
  );
  const failed = await fixture.service.createDiagram({
    format: "bpmn",
    type: "bpmn",
    title: "Retained BPMN",
  });
  expect(failed).toMatchObject({ status: "failed", stage: "presentation" });
  const page = fixture.pages.get(failed.docId)!;
  const before = page
    .getBlocksByFlavour("myoxus:bpmn")[0]
    .model.yBlock.toJSON();
  await expect(
    fixture.service.createDiagram({
      format: "bpmn",
      type: "bpmn",
      title: "Do not duplicate",
    }),
  ).resolves.toMatchObject({ docId: failed.docId, status: "failed" });
  const reopened = fixture.reopen();
  reopened.restoreCreation(failed.docId);
  await expect(reopened.retryCreation(failed.docId)).resolves.toEqual({
    status: "ready",
    docId: failed.docId,
  });
  expect(fixture.provision).toHaveBeenCalledOnce();
  expect(
    page.getBlocksByFlavour("myoxus:bpmn")[0].model.yBlock.toJSON(),
  ).toEqual(before);
});

test("standalone file import preserves bytes and retries only its failed target after partial completion", async () => {
  const fixture = catalogFixture();
  const exact = "\uFEFF" + createBlankBpmnSource().replaceAll("\n", "\r\n");
  const preserved = createBlankBpmnSource().replace(
    /\s*<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/,
    "",
  );
  const files = [
    new File([exact], "edited-eol.bpmn"),
    new File(["<broken"], "malformed.bpmn"),
    new File([preserved], "no-di.bpmn"),
    new File([exact], "queued.bpmn"),
    new File(["<!DOCTYPE definitions><definitions/>"], "unsafe.bpmn"),
    new File([new Uint8Array([255])], "encoding.bpmn"),
    new File(['<?xml version="1.1"?><html/>'], "version-before-root.bpmn"),
  ];
  fixture.setPrimaryMode
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("presentation failed"));
  const partial = await runBpmnImport(
    fixture.service,
    await prepareBpmnImport(files),
  );
  expect(partial.docIds).toHaveLength(1);
  const failed = partial.entries[2].creation!;
  expect(failed.status).toBe("failed");
  expect(partial.entries[3].creation).toBeUndefined();
  const complete = await runBpmnImport(fixture.service, partial);
  expect(complete.docIds).toHaveLength(3);
  expect(new Set(complete.docIds).size).toBe(3);
  expect(fixture.provision).toHaveBeenCalledTimes(3);
  expect(complete.entries[0].creation).toEqual(partial.entries[0].creation);
  expect(complete.entries[2].creation).toEqual({
    status: "ready",
    docId: failed.docId,
  });
  for (const index of [1, 4, 5, 6])
    expect(complete.entries[index].creation).toBeUndefined();
  for (const index of [0, 2, 3]) {
    const entry = complete.entries[index];
    const page = fixture.pages.get(entry.creation!.docId)!;
    const source = page
      .getBlocksByFlavour("myoxus:bpmn")[0]
      .model.yBlock.get("prop:sourceHeads") as Y.Map<string>;
    expect([...source.values()]).toEqual([index === 2 ? preserved : exact]);
    expect([...new Uint8Array(await entry.file.arrayBuffer())]).toEqual([
      ...entry.inspection.bytes,
    ]);
  }
});

test("missing catalog source never becomes guessed blank BPMN or default Mermaid on mount", async () => {
  const fixture = catalogFixture();
  const result = await fixture.service.createDiagram({
    format: "bpmn",
    type: "bpmn",
    title: "Missing source",
  });
  const page = fixture.pages.get(result.docId)!;
  const block = page.getBlocksByFlavour("myoxus:bpmn")[0].model;
  page.spaceDoc.transact(() => {
    (block.yBlock.get("prop:sourceHeads") as Y.Map<string>).clear();
    (block.yBlock.get("prop:sourceLinks") as Y.Map<string>).clear();
  });
  await expect(
    fixture.reopen().retryCreation(result.docId),
  ).resolves.toMatchObject({
    status: "failed",
    docId: result.docId,
    stage: "content",
  });
  page.deleteBlock(page.getBlocksByFlavour("myoxus:bpmn")[0].model);
  const initial = fixture.service.getInitialDiagramForEditor(
    result.docId,
    page,
  )!;
  expect(initial.format).toBe("bpmn");
  expect(fixture.service.initializeBpmnForEditor(result.docId, page)).toEqual({
    status: "retryable",
  });
  fixture.service.releaseInitialDiagramForEditor(result.docId, initial.claim);
  const remounted = fixture.service.getInitialDiagramForEditor(
    result.docId,
    page,
  )!;
  fixture.service.releaseInitialDiagramForEditor(result.docId, initial.claim);
  fixture.service.completeInitialDiagramForEditor(result.docId, initial.claim);
  expect(
    fixture.service.isInitialDiagramClaimCurrent(result.docId, remounted.claim),
  ).toBe(true);
  expect(
    fixture.service.getInitialDiagramForEditor(result.docId, page),
  ).toBeNull();
  fixture.service.releaseInitialDiagramForEditor(result.docId, remounted.claim);
  fixture.records.get(result.docId)!.meta$.next({ title: "Unknown format" });
  expect(
    fixture.service.getInitialDiagramForEditor(result.docId, page),
  ).toBeNull();
  expect(page.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(0);
  expect(page.getBlocksByFlavour("myoxus:mermaid")).toHaveLength(0);
});

test("delayed BPMN initialization replays the same CRDT identities and never deletes an edited skeleton", () => {
  const doc = nativeDoc();
  initDocFromProps(doc);
  const skeleton = Y.encodeStateAsUpdate(doc.spaceDoc);
  const delayed = nativeDoc(skeleton);
  const edited = nativeDoc(skeleton);
  const reconnecting = nativeDoc(skeleton);
  const paragraph = edited.getBlocksByFlavour("myoxus:paragraph")[0].model;
  paragraph.text!.insert("Keep this user content", 0);
  const attempt = prepareBpmnInitialization();
  expect(initializeBpmnDocument(doc, attempt)).toEqual({
    status: "initialized",
    blockId: attempt.blockId,
  });
  expect(initializeBpmnDocument(delayed, attempt)).toEqual({
    status: "initialized",
    blockId: attempt.blockId,
  });
  const block = delayed.getBlock(attempt.blockId)!.model as BpmnBlockModel;
  commitBpmnSourceRevision(block.yBlock, {
    id: crypto.randomUUID(),
    parent: block.props.selectedHead,
    supersedes: [],
    source: Object.values(block.props.sourceHeads)[0].replace(
      "<process ",
      '<process name="Edited after initialization" ',
    ),
  });
  const editedHead = block.props.selectedHead;
  Y.applyUpdate(delayed.spaceDoc, attempt.update!);
  expect(initializeBpmnDocument(delayed, attempt).status).toBe("initialized");
  Y.applyUpdate(doc.spaceDoc, Y.encodeStateAsUpdate(delayed.spaceDoc));
  expect(initializeBpmnDocument(doc, attempt).status).toBe("initialized");
  expect(
    (doc.getBlock(attempt.blockId)!.model as BpmnBlockModel).props.selectedHead,
  ).toBe(editedHead);
  expect(doc.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(1);
  expect(
    doc.getBlock(attempt.skeleton!.noteId)!.model.children.map((b) => b.id),
  ).toEqual([attempt.blockId]);
  expect(initializeBpmnDocument(edited, attempt)).toEqual({
    status: "collision",
  });
  expect(paragraph.text!.toString()).toBe("Keep this user content");
  expect(edited.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(0);
  // Reconnect delivers a peer's user edit before a delayed claimant considers
  // replaying the creation operations. It must preserve that shared paragraph.
  Y.applyUpdate(reconnecting.spaceDoc, Y.encodeStateAsUpdate(edited.spaceDoc));
  expect(initializeBpmnDocument(reconnecting, attempt)).toEqual({
    status: "collision",
  });
  Y.applyUpdate(edited.spaceDoc, Y.encodeStateAsUpdate(reconnecting.spaceDoc));
  expect(
    reconnecting
      .getBlocksByFlavour("myoxus:paragraph")[0]
      .model.text!.toString(),
  ).toBe("Keep this user content");
  expect(paragraph.text!.toString()).toBe("Keep this user content");
  expect(reconnecting.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(0);
});

function docWithFlavours(flavours: readonly string[]) {
  return {
    getBlocksByFlavour: vi.fn((flavour: string) =>
      flavours.includes(flavour) ? [{ model: { flavour } }] : [],
    ),
  } as unknown as Store;
}

describe("diagram initial content guard", () => {
  test("treats Mermaid blocks as initialized diagram content", () => {
    expect(
      hasInitializedDiagramContent(docWithFlavours(["myoxus:mermaid"])),
    ).toBe(true);
  });

  test("treats embedded server-backed databases as initialized diagram content", () => {
    expect(
      hasInitializedDiagramContent(docWithFlavours(["myoxus:database"])),
    ).toBe(true);
  });

  test("treats BPMN blocks as initialized diagram content", () => {
    expect(hasInitializedDiagramContent(docWithFlavours(["myoxus:bpmn"]))).toBe(
      true,
    );
  });

  test("keeps empty diagram docs eligible for initial insertion", () => {
    expect(hasInitializedDiagramContent(docWithFlavours([]))).toBe(false);
  });
});
