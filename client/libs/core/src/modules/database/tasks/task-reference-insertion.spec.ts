// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { DocsService } from "@myoxus/core/modules/doc";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { FrameworkProvider } from "@myoxus/infra";
import { DatabaseReferenceBlockModel } from "@virgultum/block-database/reference-store";
import type { BlockStdScope } from "@virgultum/editor/std";
import { Text, type BlockModel } from "@virgultum/editor/store";
import { TestWorkspace } from "@virgultum/editor/store/test";
import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { GfxControllerIdentifier, Viewport } from "@virgultum/editor/std/gfx";
import { DEFAULT_NOTE_OFFSET_Y } from "@virgultum/editor/blocks/surface";
import { NoteBlockModel, NoteDisplayMode } from "@virgultum/editor/model";
import { snapshotTaskCaptureSelection } from "@myoxus/core/editor/view-extensions/editor-config/toolbar/task-capture-selection";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createTaskReferenceInserter } from "./task-reference-insertion";

const source = {
  sourceDocumentId: "immutable-doc",
  sourceExternalId: "source-key",
  blockId: "nested-checkbox",
};
const target = {
  workspaceId: "workspace",
  databaseId: "project",
  rowId: "task",
};
let ownerNumber = 0;
function fixture() {
  const host = document.createElement("div");
  document.body.append(host);
  const top = {
    id: "top-list",
    flavour: "myoxus:list",
    children: [] as BlockModel[],
    text: { toString: () => "Original parent" },
  };
  const nested = {
    id: source.blockId,
    flavour: "myoxus:list",
    children: [],
    text: { toString: () => "Original checkbox" },
  };
  top.children.push(nested as unknown as BlockModel);
  const note = { id: "note", flavour: "myoxus:note", children: [top] };
  const blocks = new Map<string, object>([
    [top.id, top],
    [nested.id, nested],
    [note.id, note],
  ]);
  const parent = new Map<string, { id: string }>([
    [top.id, note],
    [nested.id, top],
  ]);
  const yDoc = {};
  const waitForSynced = vi.fn(async () => {});
  const release = vi.fn();
  const can = vi.fn(async () => true);
  const server = {
    id: "server",
    baseUrl: "https://myoxus.test",
    account$: { value: { id: `actor-${++ownerNumber}` } },
  };
  const identity = JSON.stringify([
    server.id,
    server.baseUrl,
    server.account$.value.id,
    "workspace",
  ]);
  const services = new Map<unknown, unknown>([
    [WorkspaceServerService, { server }],
    [
      DocumentMetadataCacheService,
      {
        getModel: () => ({ metadata: { docId: source.sourceDocumentId } }),
        getIndexRowByExternalId: vi.fn(),
      },
    ],
    [GuardService, { can }],
    [
      DocsService,
      {
        open: () => ({
          doc: { yDoc, waitForSyncReady: vi.fn(async () => {}) },
          release,
        }),
      },
    ],
    [WorkspaceService, { workspace: { engine: { doc: { waitForSynced } } } }],
  ]);
  const addBlock = vi.fn(
    (
      _flavour: string,
      props: object & { id: string },
      _note: unknown,
      _index: number,
    ) => {
      const model = Object.create(
        DatabaseReferenceBlockModel.prototype,
      ) as DatabaseReferenceBlockModel;
      Object.defineProperties(model, {
        props: { value: props },
        id: { value: props.id },
      });
      blocks.set(props.id, model);
      return props.id;
    },
  );
  const std = {
    host,
    workspace: { id: "workspace" },
    get: () => ({ getEditorMode: () => "page" }),
    store: {
      readonly: false,
      doc: {
        id: source.sourceExternalId,
        spaceDoc: yDoc,
        workspace: { idGenerator: () => crypto.randomUUID() },
      },
      getBlock: (id: string) =>
        blocks.has(id) ? { model: blocks.get(id) } : undefined,
      getParent: (model: { id: string }) => parent.get(model.id),
      captureSync: vi.fn(),
      addBlock,
    },
  } as unknown as BlockStdScope;
  const framework = {
    get: (service: unknown) => services.get(service),
  } as unknown as FrameworkProvider;
  return {
    framework,
    services,
    std,
    host,
    identity,
    addBlock,
    waitForSynced,
    release,
    can,
    server,
    top,
    note,
    nested,
  };
}
afterEach(() => document.body.replaceChildren());

test("lost acknowledgement reads the same block ID before retry and inserts outside a nested checkbox", async () => {
  const f = fixture();
  f.waitForSynced
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("lost ack"));
  const insert = createTaskReferenceInserter(f.framework, f.std, f.identity);
  expect(await insert("capture-request", target, source)).toBe("uncertain");
  expect(f.addBlock).toHaveBeenCalledWith(
    "myoxus:database",
    expect.objectContaining({
      serverWorkspaceId: "workspace",
      serverDatabaseId: "project",
      serverRowId: "task",
      serverViewId: null,
    }),
    f.note,
    1,
  );
  expect(f.nested.text.toString()).toBe("Original checkbox");
  expect(await insert("capture-request", target, source)).toBe("inserted");
  expect(f.addBlock).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledTimes(2);
  insert.releaseConfirmed("capture-request");
});

test("owner change during the permission await prevents source writes", async () => {
  const f = fixture();
  let permit!: (value: boolean) => void;
  f.can.mockResolvedValueOnce(true).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        permit = resolve;
      }),
  );
  const insert = createTaskReferenceInserter(f.framework, f.std, f.identity);
  const pending = insert("changed-owner", target, source);
  await waitFor(() => expect(f.can).toHaveBeenCalledTimes(2));
  f.server.account$.value.id = "different-actor";
  permit(true);
  expect(await pending).toBe("failed");
  expect(f.addBlock).not.toHaveBeenCalled();
});

test("readonly source cannot append a Task reference or open a writable document", async () => {
  const f = fixture();
  Object.defineProperty(f.std.store, "readonly", { value: true });
  const insert = createTaskReferenceInserter(f.framework, f.std, f.identity);
  expect(await insert("readonly-source", target, source)).toBe("readonly");
  expect(f.addBlock).not.toHaveBeenCalled();
  expect(f.can).not.toHaveBeenCalled();
  expect(f.waitForSynced).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
});

function nativeFixture() {
  const f = fixture();
  const workspace = new TestWorkspace({ id: "workspace" });
  workspace.storeExtensions = getStoreManager()
    .config.init()
    .value.get("store");
  workspace.meta.initialize();
  const doc = workspace.createDoc(source.sourceExternalId);
  doc.load();
  const store = doc.getStore();
  const root = store.addBlock("myoxus:page", {
    title: new Text("Capture source"),
  });
  const originalGeometry = "[748.4615,39.1923,498,89]";
  const noteId = store.addBlock(
    "myoxus:note",
    { xywh: originalGeometry, displayMode: NoteDisplayMode.EdgelessOnly },
    root,
  );
  store.addBlock(
    "myoxus:list",
    {
      id: source.blockId,
      type: "todo",
      checked: false,
      text: new Text("Original checkbox"),
    },
    noteId,
  );
  const model = store.getBlock(source.blockId)!.model;
  const note = store.getModelById<NoteBlockModel>(noteId)!;
  let mode = "edgeless";
  const modeProvider = { getEditorMode: () => mode };
  const viewport = new Viewport();
  viewport.setRect(50, 75, 1200, 800);
  viewport.setViewport(0.65, [400, 240], false, false);
  const gfx = { doc: store, viewport };
  const crud = {
    addBlock: (
      flavour: string,
      props: object,
      parent?: string | BlockModel,
      index?: number,
    ) => store.addBlock(flavour, props, parent, index),
  };
  const std = {
    host: f.host,
    workspace: { id: workspace.id },
    store,
    selection: { find: () => undefined },
    get: (id: unknown) =>
      id === DocModeProvider
        ? modeProvider
        : id === GfxControllerIdentifier
          ? gfx
          : crud,
    getOptional: (id: unknown) =>
      id === DocModeProvider ? modeProvider : undefined,
  } as unknown as BlockStdScope;
  f.services.set(DocsService, {
    open: () => ({
      doc: { yDoc: store.doc.spaceDoc, waitForSyncReady: async () => {} },
      release: f.release,
    }),
  });
  const snapshot = snapshotTaskCaptureSelection(std, [model])!;
  const frozen = { ...source, selectionAnchor: snapshot.selectionAnchor };
  const insert = createTaskReferenceInserter(f.framework, std, f.identity);
  return {
    ...f,
    std,
    store,
    workspace,
    note,
    model,
    originalGeometry,
    viewport,
    frozen,
    insert,
    setMode: (value: string) => {
      mode = value;
    },
  };
}

test("Edgeless capture creates a separate native Note below the unchanged sticky; one Undo/Redo owns only the reference tree", async () => {
  const f = nativeFixture();
  try {
    const originalRootChildren = f.store.root!.children.map(
      (model) => model.id,
    );
    f.waitForSynced
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("lost ack"));
    expect(await f.insert("sticky-capture", target, f.frozen)).toBe(
      "uncertain",
    );
    const reference = f.store.getBlocksByFlavour("myoxus:database")[0]!.model;
    const adjacent = f.store.getModelById<NoteBlockModel>(
      f.store.getParent(reference)!.id,
    )!;
    expect(adjacent.id).not.toBe(f.note.id);
    expect(adjacent.props.displayMode).toBe(NoteDisplayMode.DocAndEdgeless);
    const [x, y] = JSON.parse(adjacent.props.xywh as string);
    expect(f.viewport.left).toBe(50);
    expect(f.viewport.top).toBe(75);
    expect(x).toBeCloseTo(748.4615);
    expect(y).toBeCloseTo(39.1923 + 89 + DEFAULT_NOTE_OFFSET_Y);
    expect(f.note.props.xywh).toBe(f.originalGeometry);
    expect(f.note.children.map((model) => model.id)).toEqual([source.blockId]);
    expect(f.model.text?.toString()).toBe("Original checkbox");
    expect(await f.insert("sticky-capture", target, f.frozen)).toBe("inserted");
    expect(f.store.getBlocksByFlavour("myoxus:database")).toHaveLength(1);
    expect(f.store.getBlocksByFlavour("myoxus:note")).toHaveLength(2);
    f.store.undo();
    expect(f.store.getBlock(reference.id)).toBeUndefined();
    expect(f.store.getBlock(adjacent.id)).toBeUndefined();
    expect(f.store.root!.children.map((model) => model.id)).toEqual(
      originalRootChildren,
    );
    expect(f.model.text?.toString()).toBe("Original checkbox");
    expect(f.note.props.xywh).toBe(f.originalGeometry);
    expect(await f.insert("sticky-capture", target, f.frozen)).toBe("failed");
    f.store.redo();
    expect(
      f.store.getModelById<DatabaseReferenceBlockModel>(reference.id)?.props
        .serverRowId,
    ).toBe(target.rowId);
    expect(f.store.getParent(f.store.getBlock(reference.id)!.model)?.id).toBe(
      adjacent.id,
    );
    expect(f.note.props.xywh).toBe(f.originalGeometry);
    expect(f.model.text?.toString()).toBe("Original checkbox");
    f.insert.releaseConfirmed();
  } finally {
    f.viewport.dispose();
    f.workspace.dispose();
  }
});

test.each(["mode", "source-note"])(
  "an async %s change cannot substitute a new placement for the frozen sticky intent",
  async (change) => {
    const f = nativeFixture();
    let permit!: (value: boolean) => void;
    f.can.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          permit = resolve;
        }),
    );
    try {
      const pending = f.insert("changed-sticky-intent", target, f.frozen);
      await waitFor(() => expect(f.can).toHaveBeenCalledTimes(2));
      if (change === "mode") f.setMode("page");
      else {
        const other = f.store.addBlock("myoxus:note", {}, f.store.root!);
        f.store.moveBlocks([f.model], f.store.getBlock(other)!.model);
      }
      permit(true);
      expect(await pending).toBe("failed");
      expect(f.store.getBlocksByFlavour("myoxus:database")).toHaveLength(0);
      expect(f.note.props.xywh).toBe(f.originalGeometry);
      expect(f.model.text?.toString()).toBe("Original checkbox");
    } finally {
      f.viewport.dispose();
      f.workspace.dispose();
    }
  },
);
