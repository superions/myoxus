// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import "@myoxus/theme/style.css";

import * as note from "@virgultum/editor/blocks/note";
import type {
  EdgelessRootBlockComponent,
  PageRootBlockComponent,
} from "@virgultum/editor/blocks/root";
import { SurfaceBlockComponent } from "@virgultum/editor/blocks/surface";
import {
  type ViewportTurboRendererExtension,
  ViewportTurboRendererIdentifier,
} from "@virgultum/editor/gfx/turbo-renderer";
import * as globalUtils from "@virgultum/editor/global/utils";
import type { DocMode } from "@virgultum/editor/model";
import * as editorModel from "@virgultum/editor/model";
import { MyoxusSchemas } from "@virgultum/editor/schemas";
import {
  createMyoxusHostService,
  DocModeExtension,
  type DocModeProvider,
  FeatureFlagService,
  MyoxusHostExtension,
  type MyoxusHostService,
} from "@virgultum/editor/shared/services";
import * as services from "@virgultum/editor/shared/services";
import * as blockStd from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import * as store from "@virgultum/editor/store";
import { Schema, Text, Transformer } from "@virgultum/editor/store";
import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from "@virgultum/editor/store/test";
import { Subscription } from "rxjs";
import { applyUpdate } from "yjs";

import { mountFrameNavigatorFixture } from "../chrome-host.js";
import {
  getTestStoreManager,
  registerTestEditorHost,
  TestMyoxusEditorContainer,
} from "./editor-host.js";
import * as editorModule from "./index.js";

registerTestEditorHost();
const sharedStoreExtensions = getTestStoreManager().get("store");

export interface TestSessionOptions {
  enableDomRenderer?: boolean;
}

/**
 * Builds a deterministic `MyoxusHostService` stub for integration fixtures.
 * Tests may enable capabilities or spy on individual host callbacks directly.
 */
export function createTestMyoxusHostService(): MyoxusHostService {
  return createMyoxusHostService({
    capabilities: [],
    openEventEditDialog: async () => null,
    resolveEventData: async () => null,
    hasImageProxyUrl: () => false,
    isFeatureEnabled: () => false,
    getWorkspaceId: () => "test-workspace",
  });
}

export function createTurboWorker(): Worker {
  return new Worker(new URL("./turbo-worker.ts", import.meta.url), {
    type: "module",
  });
}

export function getTurboRenderer(): ViewportTurboRendererExtension {
  return editor.std.get(
    ViewportTurboRendererIdentifier,
  ) as ViewportTurboRendererExtension;
}

export function getMountedSurface(
  targetDoc: Store,
  targetEditor: TestMyoxusEditorContainer,
): SurfaceBlockComponent {
  const surface = targetEditor.host?.std.get(
    GfxControllerIdentifier,
  ).surfaceComponent;
  if (
    !(surface instanceof SurfaceBlockComponent) ||
    surface.model.store !== targetDoc
  ) {
    throw new Error(
      "The active Canvas has no mounted surface for this document",
    );
  }
  return surface;
}

export function getEdgelessRoot(
  targetDoc: Store,
  targetEditor: TestMyoxusEditorContainer,
  mode: "page",
): PageRootBlockComponent;
export function getEdgelessRoot(
  targetDoc: Store,
  targetEditor: TestMyoxusEditorContainer,
  mode?: "edgeless",
): EdgelessRootBlockComponent;
export function getEdgelessRoot(
  targetDoc: Store,
  targetEditor: TestMyoxusEditorContainer,
  _mode?: "edgeless" | "page",
): EdgelessRootBlockComponent | PageRootBlockComponent {
  return targetEditor.host!.view.getBlock(targetDoc.root!.id) as
    EdgelessRootBlockComponent | PageRootBlockComponent;
}

export function insertTestNote(
  targetDoc: Store,
  props: Record<string, unknown> = {},
): string {
  const noteId = targetDoc.addBlock(
    "myoxus:note",
    { xywh: "[0, 0, 800, 100]", ...props },
    targetDoc.root,
  );
  targetDoc.addBlock("myoxus:paragraph", {}, noteId);
  return noteId;
}

export function populateSampleNotes(targetDoc: Store, count: number): void {
  const columns = Math.ceil(Math.sqrt(count));
  const width = 500;
  const height = 250;
  const gap = 50;
  const rootId = targetDoc.getBlocksByFlavour("myoxus:page")[0]?.id;

  for (let i = 0; i < count; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const xywh = `[${col * (width + gap)},${row * (height + gap)},${width},${height}]`;
    const noteId = targetDoc.addBlock("myoxus:note", { xywh }, rootId);
    targetDoc.addBlock(
      "myoxus:paragraph",
      { text: new Text(`Note ${i + 1}`) },
      noteId,
    );
    targetDoc.addBlock(
      "myoxus:paragraph",
      { text: new Text("Hello World!") },
      noteId,
    );
    targetDoc.addBlock(
      "myoxus:paragraph",
      {
        text: new Text(
          "Hello World! Lorem ipsum dolor sit amet. Consectetur adipiscing elit. Sed do eiusmod tempor incididunt.",
        ),
      },
      noteId,
    );
    targetDoc.addBlock(
      "myoxus:paragraph",
      {
        text: new Text("Multi-script wrap sample: 测试自动换行段落文本内容。"),
      },
      noteId,
    );
  }
}

function createDocModeProvider(
  container: TestMyoxusEditorContainer,
): DocModeProvider {
  const primaryModes = new Map<string, DocMode>();
  return {
    getEditorMode: () => container.mode,
    setEditorMode: (mode) => container.switchEditor(mode),
    getPrimaryMode: (docId) => primaryModes.get(docId) ?? "page",
    setPrimaryMode: (mode, docId) => {
      primaryModes.set(docId, mode);
    },
    togglePrimaryMode: (docId) => {
      const next: DocMode =
        primaryModes.get(docId) === "edgeless" ? "page" : "edgeless";
      primaryModes.set(docId, next);
      return next;
    },
    onPrimaryModeChange: () => new Subscription(),
  };
}

/**
 * Mounts an isolated `TestWorkspace` + `<myoxus-editor-container>` session on
 * `window` and returns a teardown callback that unmounts DOM and clears globals.
 */
export async function mountTestSession(
  mode: DocMode = "page",
  extensions: ExtensionType[] = [],
  options: TestSessionOptions = {},
): Promise<() => void> {
  const schema = new Schema().register(MyoxusSchemas);
  const workspaceOptions = {
    id: Math.random().toString(16).slice(2, 8),
    schema,
    idGenerator: createAutoIncrementIdGenerator(),
  };
  const workspace = new TestWorkspace(workspaceOptions);
  workspace.storeExtensions = sharedStoreExtensions;
  workspace.meta.initialize();

  window.collection = workspace;
  window.job = new Transformer({
    schema: new Schema().register(MyoxusSchemas),
    blobCRUD: workspace.blobSync,
    docCRUD: {
      create: (id: string) => workspace.createDoc(id).getStore({ id }),
      get: (id: string) => workspace.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => workspace.removeDoc(id),
    },
  });
  window.$virgultum = Object.freeze({
    store,
    blocks: { note },
    global: { utils: globalUtils },
    services,
    editor: editorModule,
    blockStd,
    editorModel,
  });
  window.mountFrameNavigatorFixture = mountFrameNavigatorFixture;
  window.applyNativeUpdate = async (update) => {
    const imported = workspace.createDoc("native-fixture").getStore();
    applyUpdate(imported.spaceDoc, Uint8Array.from(update));
    imported.load();
    imported.resetHistory();
    window.doc = imported;
    window.editor.doc = imported;
    await window.editor.updateComplete;
    window.host = window.editor.host;
  };

  const homeDoc = workspace.createDoc("doc:home").getStore();
  homeDoc.load(() => {
    const rootId = homeDoc.addBlock("myoxus:page", { title: new Text() });
    if (mode === "edgeless") {
      homeDoc.addBlock("myoxus:surface", {}, rootId);
    }
  });
  homeDoc.resetHistory();

  if (options.enableDomRenderer) {
    homeDoc.get(FeatureFlagService)?.setFlag("enable_dom_renderer", true);
  }

  const hostRoot = document.createElement("div");
  Object.assign(hostRoot.style, {
    width: "100%",
    height: "1280px",
    overflowY: "auto",
  });

  const container = new TestMyoxusEditorContainer();
  container.doc = homeDoc;
  container.mode = mode;

  const docModeExt = DocModeExtension(createDocModeProvider(container));
  const hostService = createTestMyoxusHostService();
  const hostExt = MyoxusHostExtension(hostService);

  container.pageSpecs = [
    ...container.viewManager.get("page"),
    docModeExt,
    hostExt,
    ...extensions,
  ];
  container.edgelessSpecs = [
    ...container.viewManager.get("edgeless"),
    docModeExt,
    hostExt,
    ...extensions,
  ];

  hostRoot.append(container);
  window.editor = container;
  window.doc = homeDoc;
  window.myoxusHostService = hostService;

  document.body.append(hostRoot);
  await container.chromeReady;
  await container.updateComplete;
  await container.host?.updateComplete;
  window.host = container.host;

  return () => {
    hostRoot.remove();
    disposeTestSession();
  };
}

export function disposeTestSession(): void {
  window.editor?.remove();
  const win = window as unknown as Record<string, unknown>;
  delete win.collection;
  delete win.doc;
  delete win.editor;
  delete win.host;
  delete win.job;
  delete win.renderer;
  delete win.myoxusHostService;
  delete win.$virgultum;
  delete win.applyNativeUpdate;
  delete win.mountFrameNavigatorFixture;
}

declare global {
  const editor: TestMyoxusEditorContainer;
  const doc: Store;
  const collection: TestWorkspace;
  const job: Transformer;
  interface Window {
    applyNativeUpdate: (update: number[]) => Promise<void>;
    mountFrameNavigatorFixture: typeof mountFrameNavigatorFixture;
    editor: TestMyoxusEditorContainer;
    doc: Store;
    job: Transformer;
    collection: TestWorkspace;
    host: TestMyoxusEditorContainer["host"];
    myoxusHostService: MyoxusHostService;
    $virgultum: {
      store: typeof store;
      blocks: {
        note: typeof note;
      };
      global: {
        utils: typeof globalUtils;
      };
      services: typeof services;
      editor: typeof editorModule;
      blockStd: typeof blockStd;
      editorModel: typeof editorModel;
    };
    renderer: ViewportTurboRendererExtension;
  }
}
