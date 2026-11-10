import "@myoxus/theme/style.css";

import * as note from "@virgultum/editor/blocks/note";
import * as globalUtils from "@virgultum/editor/global/utils";
import type { DocMode } from "@virgultum/editor/model";
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
import {
  type ViewportTurboRendererExtension,
  ViewportTurboRendererIdentifier,
} from "@virgultum/gfx-turbo-renderer";
import * as model from "@virgultum/model";
import type { ExtensionType, Store } from "@virgultum/store";
import * as store from "@virgultum/store";
import { Schema, Text, Transformer } from "@virgultum/store";
import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from "@virgultum/store/test";
import { Subscription } from "rxjs";
import { applyUpdate } from "yjs";

import { effects } from "../../effects.js";
import * as editorModule from "../../index.js";
import { TestMyoxusEditorContainer } from "../../index.js";
import { getTestStoreManager } from "../../store.js";
import { getTestViewManager } from "../../view.js";

const storeManager = getTestStoreManager();
const viewManager = getTestViewManager();
effects();

const storeExtensions = storeManager.get("store");

export function getRenderer() {
  return editor.std.get(
    ViewportTurboRendererIdentifier,
  ) as ViewportTurboRendererExtension;
}

function createCollectionOptions() {
  const schema = new Schema();
  const room = Math.random().toString(16).slice(2, 8);

  schema.register(MyoxusSchemas);

  const idGenerator = createAutoIncrementIdGenerator();

  return {
    id: room,
    schema,
    idGenerator,
  };
}

function initCollection(collection: TestWorkspace, includeSurface: boolean) {
  const doc = collection.createDoc("doc:home").getStore();

  doc.load(() => {
    const rootId = doc.addBlock("myoxus:page", {
      title: new Text(),
    });
    if (includeSurface) {
      doc.addBlock("myoxus:surface", {}, rootId);
    }
  });
  doc.resetHistory();
}

async function createEditor(
  collection: TestWorkspace,
  mode: DocMode = "page",
  extensions: ExtensionType[] = [],
) {
  const app = document.createElement("div");
  const blockCollection = collection.docs.values().next().value;
  if (!blockCollection) {
    throw new Error("Need to create a doc first");
  }
  const doc = blockCollection.getStore();
  const editor = new TestMyoxusEditorContainer();
  editor.doc = doc;
  editor.mode = mode;
  const docModeExtension = DocModeExtension(createDocModeProvider(editor));
  // B-02: bind a stub `MyoxusHostService` so block code that
  // migrates from DOM CustomEvents to the typed host boundary
  // has a deterministic answer in unit tests. The stub is
  // identity-stable across `window.editor` reloads so tests
  // can monkey-patch individual methods (e.g. spy on
  // `openBpmnEditor`).
  const hostService = createTestMyoxusHostService();
  const hostExtension = MyoxusHostExtension(hostService);
  editor.pageSpecs = [
    ...viewManager.get("page"),
    docModeExtension,
    hostExtension,
    ...extensions,
  ];
  editor.edgelessSpecs = [
    ...viewManager.get("edgeless"),
    docModeExtension,
    hostExtension,
    ...extensions,
  ];
  app.append(editor);

  window.editor = editor;
  window.doc = doc;
  window.myoxusHostService = hostService;

  app.style.width = "100%";
  app.style.height = "1280px";
  app.style.overflowY = "auto";

  document.body.append(app);
  // The React chrome installs an editor extension asynchronously. Waiting for
  // it prevents tests from retaining the initial host after it is replaced.
  await editor.chromeReady;
  await editor.updateComplete;
  await editor.host?.updateComplete;
  window.host = editor.host;
  return app;
}

function createDocModeProvider(
  editor: TestMyoxusEditorContainer,
): DocModeProvider {
  const primaryModes = new Map<string, DocMode>();

  return {
    getEditorMode: () => editor.mode,
    setEditorMode: (mode) => {
      editor.switchEditor(mode);
    },
    getPrimaryMode: (docId) => primaryModes.get(docId) ?? "page",
    setPrimaryMode: (mode, docId) => {
      primaryModes.set(docId, mode);
    },
    togglePrimaryMode: (docId) => {
      const next = primaryModes.get(docId) === "edgeless" ? "page" : "edgeless";
      primaryModes.set(docId, next);
      return next;
    },
    onPrimaryModeChange: () => new Subscription(),
  };
}

/**
 * Build a `MyoxusHostService` stub for the integration-test
 * BlockStdScope. The stub starts with no capabilities; tests
 * that exercise the host boundary opt in by calling
 * `setCapability(MyoxusHostCapability.X, true)` or by
 * monkey-patching the methods.
 *
 * Tests that previously listened for
 * `myoxus-bpmn-block-action-requested` /
 * `myoxus-bpmn-block-open-requested` should now read
 * `window.myoxusHostService.<method>` (call counts, args).
 */
function createTestMyoxusHostService(): MyoxusHostService {
  // Reuse the documented factory so the capability set is
  // computed the same way as in production. The base
  // implementation overrides only the bare minimum required
  // by the B-02 surface; consumers may monkey-patch the rest.
  return createMyoxusHostService({
    capabilities: [],
    openEventEditDialog: async () => null,
    resolveEventData: async () => null,
    hasImageProxyUrl: () => false,
    isFeatureEnabled: () => false,
    getWorkspaceId: () => "test-workspace",
  });
}

export function createPainterWorker() {
  const worker = new Worker(
    new URL("./turbo-painter.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  return worker;
}

type SetupEditorOptions = {
  extensions?: ExtensionType[];
  enableDomRenderer?: boolean;
};

export async function setupEditor(
  mode: DocMode = "page",
  extensionsInput?: ExtensionType[],
  optionsInput?: SetupEditorOptions,
) {
  const extensions: ExtensionType[] = extensionsInput ?? [];
  const options: SetupEditorOptions = optionsInput ?? {};
  const enableDomRenderer = options?.enableDomRenderer ?? false;

  const collection = new TestWorkspace(createCollectionOptions());
  collection.storeExtensions = storeExtensions;
  collection.meta.initialize();

  window.collection = collection;
  window.job = new Transformer({
    schema: new Schema().register(MyoxusSchemas),
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => collection.createDoc(id).getStore({ id }),
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
  });
  window.$virgultum = Object.freeze({
    store,
    blocks: {
      note,
    },
    global: {
      utils: globalUtils,
    },
    services,
    editor: editorModule,
    blockStd,
    editorModel: model,
  });
  // Consume shipped native bytes through Yjs itself, without reconstructing
  // their tables from a review projection or a synthetic fixture model.
  window.applyNativeUpdate = async (update) => {
    // Match persisted-document loading: integrate bytes before Store observes
    // blocks, then mount the complete document rather than replace a live root.
    const imported = collection.createDoc("native-fixture").getStore();
    applyUpdate(imported.spaceDoc, Uint8Array.from(update));
    imported.load();
    imported.resetHistory();
    window.doc = imported;
    window.editor.doc = imported;
    await window.editor.updateComplete;
    window.host = window.editor.host;
  };

  initCollection(collection, mode === "edgeless");

  if (enableDomRenderer) {
    const docStore = window.collection.docs.get("doc:home")?.getStore();
    const featureFlagService = docStore?.get(FeatureFlagService);
    featureFlagService?.setFlag("enable_dom_renderer", true);
  }

  const appElement = await createEditor(collection, mode, extensions);

  return () => {
    appElement?.remove();
    cleanup();
  };
}

export function cleanup() {
  window.editor?.remove();

  delete (window as any).collection;

  delete (window as any).editor;

  delete (window as any).store;

  delete (window as any).host;

  delete (window as any).job;

  delete (window as any).myoxusHostService;

  delete (window as any).$virgultum;
  delete (window as any).applyNativeUpdate;
}

declare global {
  const editor: TestMyoxusEditorContainer;
  const doc: Store;
  const collection: TestWorkspace;
  const job: Transformer;
  interface Window {
    applyNativeUpdate: (update: number[]) => Promise<void>;
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
      editorModel: typeof model;
    };
    renderer: ViewportTurboRendererExtension;
  }
}
