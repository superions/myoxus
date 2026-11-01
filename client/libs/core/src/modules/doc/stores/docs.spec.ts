/**
 * @vitest-environment happy-dom
 */

import { UserFriendlyError } from "@myoxus/error";
import { Framework, LiveData } from "@myoxus/infra";
import type { DocFrontendDocState } from "@myoxus/storage";
import { firstValueFrom } from "rxjs";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import type { DocProperties } from "../../db/schema/schema";
import { DocumentMetadataCacheService } from "../../document-metadata/services/document-metadata-cache";
import { WorkspaceServerService } from "../../server/services/workspace-server";
import { WorkspaceMetaImpl } from "../../workspace/impls/meta";
import { WorkspaceService } from "../../workspace/services/workspace";
import { DocPropertiesStore } from "./doc-properties";
import { DocsService } from "../services/docs";
import { DocsStore } from "./docs";
import { DocumentLifecycleStore } from "./document-lifecycle";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    docId: "doc-1",
    workspaceId: "ws-1",
    system: {
      createdAt: "2056-01-01T00:00:00.000Z",
      updatedAt: "2056-01-02T00:00:00.000Z",
      createdBy: "creator-1",
      updatedBy: "updater-1",
      metadataUpdatedAt: null,
      metadataUpdatedBy: null,
    },
    journal: { journalDate: "2056-01-20" },
    template: {
      state: "managed",
      category: "building-blocks",
      tags: ["project"],
    },
    presentation: {
      primaryMode: "edgeless",
      pageWidth: "fullWidth",
      edgelessColorTheme: "dark",
    },
    integration: { integrationType: "readwise" },
    projectionVersion: "v2",
    metadataRevision: 7,
    ...overrides,
  };
}

function createStore({
  flavour,
  gql,
  waitForSynced = vi.fn(async () => undefined),
  saveDetachedUpdateAndWaitForSynced = vi.fn(async () => undefined),
  docStates = new Map<string, LiveData<DocFrontendDocState>>(),
  rootYDoc,
  docCollection,
  metadataByDocId = {},
  indexMetadataByDocId = metadataByDocId,
  localPropertyValues = new Map(),
  localPropertiesByDocId = {},
}: {
  flavour: "local" | "cloud";
  gql?: ReturnType<typeof vi.fn>;
  waitForSynced?: ReturnType<typeof vi.fn>;
  saveDetachedUpdateAndWaitForSynced?: ReturnType<typeof vi.fn>;
  docStates?: Map<string, LiveData<DocFrontendDocState>>;
  rootYDoc?: Y.Doc;
  docCollection?: { meta: WorkspaceMetaImpl };
  metadataByDocId?: Record<string, ReturnType<typeof metadata>>;
  indexMetadataByDocId?: Record<string, ReturnType<typeof metadata>>;
  localPropertyValues?: Map<string, string | undefined>;
  localPropertiesByDocId?: Record<string, Partial<DocProperties>>;
}) {
  const applyOfflineSubsystemProjection = vi.fn();
  const writeMetadataForDocument = vi.fn();
  type TestMetadataModel = { metadata: ReturnType<typeof metadata> };
  const modelStreams = new Map<string, LiveData<TestMetadataModel | null>>();
  for (const [docId, value] of Object.entries(metadataByDocId)) {
    modelStreams.set(
      docId,
      new LiveData<TestMetadataModel | null>({ metadata: value }),
    );
  }
  const hydrateModels = vi.fn(
    async (docIds: string[]) =>
      new Map(
        docIds.flatMap((docId) => {
          const model = modelStreams.get(docId)?.value;
          return model ? [[docId, model] as const] : [];
        }),
      ),
  );
  const hydrateMetadata = vi.fn(async (docId: string) => {
    const value = metadataByDocId[docId];
    if (!value) throw new Error("Missing fixture metadata");
    return value;
  });
  const watchPropertyAllValues = vi.fn(() => new LiveData(localPropertyValues));
  const watchDocProperties = vi.fn(
    (docId: string) =>
      new LiveData({
        id: docId,
        createdBy: localPropertyValues.get(docId),
        updatedBy: localPropertyValues.get(docId),
        ...localPropertiesByDocId[docId],
      }),
  );
  const framework = new Framework();
  const indexRows = () =>
    Object.entries(indexMetadataByDocId).map(([docId, value]) => ({
      docId,
      externalId: docId,
      createdBy: value.system.createdBy,
      updatedBy: value.system.updatedBy,
      journalDate: value.journal.journalDate,
      isTemplate: value.template.state !== "none",
      templateState: value.template.state,
      templateCategory: value.template.category,
      templateTags: value.template.tags,
      primaryMode: value.presentation?.primaryMode ?? null,
      pageWidth: value.presentation?.pageWidth ?? null,
      edgelessColorTheme: value.presentation?.edgelessColorTheme ?? null,
      integrationType: value.integration?.integrationType ?? null,
    }));
  const listModelOverrides = new LiveData(new Map());
  const testFramework = framework as any;
  testFramework.service(WorkspaceService, {
    workspace: {
      flavour,
      id: "ws-1",
      name$: new LiveData("Workspace"),
      rootYDoc,
      docCollection,
      engine: {
        doc: {
          docState$: (docId: string) => {
            let state: LiveData<DocFrontendDocState> | undefined =
              docStates.get(docId);
            if (!state) {
              state = new LiveData<DocFrontendDocState>({
                loaded: true,
                ready: true,
                remoteMissing: false,
                synced: false,
                syncErrorMessage: null,
                syncRetrying: false,
                syncing: true,
                updating: false,
              });
              docStates.set(docId, state);
            }
            return state;
          },
          waitForSynced,
          saveDetachedUpdateAndWaitForSynced,
        },
      },
    },
  });
  testFramework.service(WorkspaceServerService, {
    server: gql ? { gql } : null,
  });
  testFramework.service(DocPropertiesStore, {
    applyOfflineSubsystemProjection,
    getDocProperties: (docId: string) => ({
      id: docId,
      primaryMode: localPropertyValues.get(docId),
      ...localPropertiesByDocId[docId],
    }),
    watchDocProperties,
    watchPropertyAllValues,
  });
  testFramework.service(DocumentMetadataCacheService, {
    getModel: (docId: string) => modelStreams.get(docId)?.value ?? null,
    hydrateModels,
    hydrateMetadata,
    hydrateIndex: vi.fn(async () => undefined),
    invalidateIndex: vi.fn(),
    getIndexRows: indexRows,
    getIndexRowByExternalId: (docId: string) =>
      indexRows().find((row) => row.externalId === docId),
    getIndexState: () => ({
      phase: "ready",
      rows: indexRows(),
      error: null,
      generation: 0,
    }),
    watchIndexRows: () => new LiveData(indexRows()),
    watchIndexState: () =>
      new LiveData({
        phase: "ready",
        rows: indexRows(),
        error: null,
        generation: 0,
      }),
    getListModelOverride: () => null,
    watchListModelOverrides: () => listModelOverrides,
    watchModel: (docId: string) => {
      const stream = modelStreams.get(docId);
      if (stream) return stream;
      const created = new LiveData<TestMetadataModel | null>(null);
      modelStreams.set(docId, created);
      return created;
    },
    writeMetadataForDocument,
  });
  framework.store(DocumentLifecycleStore);
  framework.store(DocsStore, [
    WorkspaceService,
    WorkspaceServerService,
    DocPropertiesStore,
    DocumentMetadataCacheService,
    DocumentLifecycleStore,
  ]);

  const provider = framework.provider();

  return {
    applyOfflineSubsystemProjection,
    hydrateMetadata,
    hydrateModels,
    modelStreams,
    lifecycle: provider.get(DocumentLifecycleStore),
    docStates,
    store: provider.get(DocsStore),
    saveDetachedUpdateAndWaitForSynced,
    waitForSynced,
    watchPropertyAllValues,
    writeMetadataForDocument,
    dispose: () => provider.dispose(),
  };
}

function createRootMetaWorkspace(docs: Array<Record<string, unknown>>) {
  const rootYDoc = new Y.Doc();
  const meta = new WorkspaceMetaImpl(rootYDoc);
  const leafDocs = new Map<string, Y.Doc>();
  meta.initialize();
  for (const doc of docs) {
    meta.addDocMeta(doc as any);
  }
  return {
    rootYDoc,
    docCollection: {
      meta,
      getDoc: (id: string) => ({
        getStore: () => ({
          spaceDoc: (() => {
            let leaf = leafDocs.get(id);
            if (!leaf) {
              leaf = new Y.Doc({ guid: id });
              leafDocs.set(id, leaf);
            }
            return leaf;
          })(),
        }),
      }),
    } as any,
    leafDocs,
  };
}

async function confirmRegistration(
  docStates: Map<string, LiveData<DocFrontendDocState>>,
  id: string,
) {
  await vi.waitFor(() => expect(docStates.has(id)).toBe(true));
  const state = docStates.get(id)!;
  state.setValue({
    ...state.value,
    synced: true,
    syncing: false,
    pageRegistration: "registered",
  });
}

describe("DocsStore native subsystem metadata writes", () => {
  test("a replaced target lifecycle cancels in-flight facts and cannot publish a stale response", async () => {
    let finish!: (result: unknown) => void;
    const gql = vi.fn(
      (_request: { context: { signal: AbortSignal } }) =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { store, lifecycle } = createStore({ flavour: "cloud", gql });
    lifecycle.beginAvailableLifecycle("doc-1", "created");
    const pending = store.readTemplateValues(
      ["creator.name"],
      "doc-1",
      {},
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(gql).toHaveBeenCalledOnce());
    const requestSignal = gql.mock.calls[0][0].context.signal;
    lifecycle.markNotFound("doc-1");
    expect(requestSignal.aborted).toBe(true);
    lifecycle.beginAvailableLifecycle("doc-1", "created");
    finish({
      workspace: {
        templateContext: { requestedValues: { "creator.name": "Stale" } },
      },
    });
    await rejected;
    store.dispose();
    lifecycle.dispose();
  });
  test("template facts wait for lifecycle acknowledgement before one authoritative query", async () => {
    const values = { "creator.name": "Original creator" };
    const gql = vi.fn(async () => ({
      workspace: { templateContext: { requestedValues: values } },
    }));
    const { store, lifecycle, hydrateMetadata } = createStore({
      flavour: "cloud",
      gql,
    });
    lifecycle.beginCreating("doc-1");
    const pending = store.readTemplateValues(
      ["creator.name"],
      "doc-1",
      {},
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(hydrateMetadata).not.toHaveBeenCalled();
    expect(gql).not.toHaveBeenCalled();
    lifecycle.beginAvailableLifecycle("doc-1", "created");
    await expect(pending).resolves.toEqual(values);
    expect(gql).toHaveBeenCalledOnce();
    expect(hydrateMetadata).not.toHaveBeenCalled();
    store.dispose();
    lifecycle.dispose();
  });

  test.each(["abort", "dispose"])(
    "template lifecycle waiting ends on %s without hydration",
    async (mode) => {
      const { store, lifecycle, hydrateMetadata } = createStore({
        flavour: "cloud",
        gql: vi.fn(),
      });
      lifecycle.beginCreating("doc-1");
      const controller = new AbortController();
      const pending = store.readTemplateValues(
        ["creator.name"],
        "doc-1",
        {},
        controller.signal,
      );
      const rejected = expect(pending).rejects.toBeDefined();
      if (mode === "abort") controller.abort();
      else store.dispose();
      await rejected;
      expect(hydrateMetadata).not.toHaveBeenCalled();
      if (mode !== "dispose") store.dispose();
      lifecycle.dispose();
    },
  );

  test("local template metadata cannot fall back to root identity or time", async () => {
    const { store, lifecycle, hydrateMetadata } = createStore({
      flavour: "local",
    });
    await expect(
      store.readTemplateValues(
        ["creator.name"],
        "doc-1",
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "local-only-incompatible" });
    expect(hydrateMetadata).not.toHaveBeenCalled();
    store.dispose();
    lifecycle.dispose();
  });
  test("builder acknowledgement waits for the folded root owner before classification writes", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Builder", creationIntent: "same-attempt" },
    ]);
    const fixture = createStore({ flavour: "cloud", ...workspace });
    const signal = AbortSignal.timeout(5000);
    try {
      fixture.lifecycle.beginAvailableLifecycle("doc-1", "created");
      await fixture.store.waitForCreateAcknowledgement("doc-1", signal);
      let acknowledged = false;
      const pending = fixture.store
        .waitForCreateAcknowledgement("doc-1", signal, true)
        .then(() => {
          acknowledged = true;
        });
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      const pages = workspace.rootYDoc.getMap("meta").get("pages") as Y.Array<
        Y.Map<unknown>
      >;
      pages.push([
        new Y.Map<unknown>([
          ["id", "doc-1"],
          ["creationIntent", "same-attempt"],
          ["registrationOwner", true],
        ]),
      ]);
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      pages.delete(0, 1);
      await pending;
      fixture.store.setDocMeta("doc-1", {
        docKind: "mermaid-diagram",
        diagramFormat: "bpmn",
        diagramType: "bpmn",
      });
      expect(pages.get(0).toJSON()).toMatchObject({
        registrationOwner: true,
        docKind: "mermaid-diagram",
        diagramFormat: "bpmn",
        diagramType: "bpmn",
      });
    } finally {
      fixture.dispose();
      workspace.rootYDoc.destroy();
    }
  });

  test("confirms a recreated server document only after byte sync and registration", async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const waitForSynced = vi.fn(
      (_docId?: string, _abort?: AbortSignal) => syncGate,
    );
    const workspace = createRootMetaWorkspace([]);
    const { lifecycle, store, docStates } = createStore({
      flavour: "cloud",
      waitForSynced,
      ...workspace,
    });
    const terminalSignal = lifecycle.signal("reused-doc");
    lifecycle.markNotFound("reused-doc");

    expect(store.createDoc("reused-doc")).toBe("reused-doc");
    expect(lifecycle.state("reused-doc")).toBe("creating");
    expect(terminalSignal.aborted).toBe(true);
    expect(() => lifecycle.requestSignal("reused-doc")).toThrow(
      "Document lifecycle is awaiting initial server sync",
    );
    expect(waitForSynced).not.toHaveBeenCalled();

    workspace.leafDocs
      .get("reused-doc")
      ?.getMap("blocks")
      .set("root", "initialized");
    await vi.waitFor(() => {
      expect(waitForSynced).toHaveBeenCalledOnce();
    });
    expect(waitForSynced.mock.calls.map(([docId]) => docId)).toEqual(["ws-1"]);
    for (const [, signal] of waitForSynced.mock.calls) {
      expect(signal?.aborted).toBe(false);
      expect(signal?.throwIfAborted).toEqual(expect.any(Function));
    }

    releaseSync();
    await vi.waitFor(() => expect(docStates.has("reused-doc")).toBe(true));
    const unregistered = docStates.get("reused-doc")!;
    unregistered.setValue({
      ...unregistered.value,
      synced: true,
      pageRegistration: "pending",
    });
    expect(lifecycle.state("reused-doc")).toBe("creating");
    await confirmRegistration(docStates, "reused-doc");
    await vi.waitFor(() => {
      expect(lifecycle.state("reused-doc")).toBe("available");
    });
    expect(lifecycle.signal("reused-doc").aborted).toBe(false);
  });

  test("queues creation metadata until the first root and leaf sync is confirmed", async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const waitForSynced = vi.fn(() => syncGate);
    const gql = vi.fn(async () => ({
      setDocumentMetadata: { metadata: metadata() },
    }));
    const workspace = createRootMetaWorkspace([]);
    const { lifecycle, store, docStates } = createStore({
      flavour: "cloud",
      gql,
      waitForSynced,
      ...workspace,
    });

    store.createDoc("new-doc");
    expect(
      workspace.docCollection.meta.getDocMeta("new-doc")?.tags,
    ).toBeUndefined();
    const metadataWrite = store.setDocPrimaryModeSetting("new-doc", "page");
    await Promise.resolve();

    expect(lifecycle.state("new-doc")).toBe("creating");
    expect(waitForSynced).not.toHaveBeenCalled();
    expect(gql).not.toHaveBeenCalled();

    workspace.leafDocs
      .get("new-doc")
      ?.getMap("blocks")
      .set("root", "initialized");
    await vi.waitFor(() => {
      expect(waitForSynced).toHaveBeenCalledOnce();
    });
    expect(gql).not.toHaveBeenCalled();

    releaseSync();
    expect(lifecycle.state("new-doc")).toBe("creating");
    await confirmRegistration(docStates, "new-doc");
    await metadataWrite;

    expect(lifecycle.state("new-doc")).toBe("available");
    expect(waitForSynced).toHaveBeenCalledOnce();
    expect(gql).toHaveBeenCalledOnce();
  });

  test("does not accept an idle sync state before the initial leaf is saved", async () => {
    let releaseLeafSave!: () => void;
    const leafSave = new Promise<void>((resolve) => {
      releaseLeafSave = resolve;
    });
    const saveDetachedUpdateAndWaitForSynced = vi.fn(() => leafSave);
    const waitForSynced = vi.fn(async () => undefined);
    const workspace = createRootMetaWorkspace([]);
    const { lifecycle, store, docStates } = createStore({
      flavour: "cloud",
      saveDetachedUpdateAndWaitForSynced,
      waitForSynced,
      ...workspace,
    });

    store.createDoc("new-doc");
    workspace.leafDocs
      .get("new-doc")
      ?.getMap("blocks")
      .set("root", "initialized");

    await vi.waitFor(() => {
      expect(saveDetachedUpdateAndWaitForSynced).toHaveBeenCalledOnce();
    });
    expect(waitForSynced).not.toHaveBeenCalled();
    expect(lifecycle.state("new-doc")).toBe("creating");

    releaseLeafSave();
    await confirmRegistration(docStates, "new-doc");
    await vi.waitFor(() => {
      expect(waitForSynced).toHaveBeenCalledTimes(1);
      expect(lifecycle.state("new-doc")).toBe("available");
    });
  });

  test("keeps local document creation immediately available without sync", () => {
    const workspace = createRootMetaWorkspace([]);
    const waitForSynced = vi.fn(async () => undefined);
    const { lifecycle, store } = createStore({
      flavour: "local",
      waitForSynced,
      ...workspace,
    });
    lifecycle.markNotFound("local-doc");

    expect(store.createDoc("local-doc")).toBe("local-doc");
    expect(workspace.docCollection.meta.getDocMeta("local-doc")?.tags).toEqual(
      [],
    );
    expect(lifecycle.state("local-doc")).toBe("available");
    expect(waitForSynced).not.toHaveBeenCalled();
    const reopened = new Y.Doc();
    Y.applyUpdate(
      reopened,
      Y.encodeStateAsUpdate(workspace.leafDocs.get("local-doc")!),
    );
    expect(reopened.getMap("meta").get("pageCreationId")).toBe("local-doc");
    expect(reopened.getMap("meta").get("pageCreationIntent")).toEqual(
      workspace.docCollection.meta.getDocMeta("local-doc")?.creationIntent,
    );
    expect(reopened.getMap("meta").get("pageCreationIntent")).toEqual(
      expect.any(String),
    );
    reopened.destroy();
  });

  test("does not revive an id when root document creation did not materialize", () => {
    const { lifecycle, store } = createStore({
      flavour: "cloud",
      rootYDoc: new Y.Doc(),
    });
    lifecycle.markNotFound("failed-create");

    expect(store.createDoc("failed-create")).toBe("failed-create");
    expect(lifecycle.state("failed-create")).toBe("not-found");
  });

  test("observed remote removal aborts requests and cancels pending membership confirmation", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "remote-doc", title: "Remote", createDate: 1 },
    ]);
    const { store, lifecycle, docStates } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    const previousSignal = lifecycle.requestSignal("remote-doc");
    const add = () =>
      workspace.docCollection.meta.addDocMeta({
        id: "remote-doc",
        title: "Remote",
        createDate: 1,
      } as any);
    const remove = () =>
      workspace.docCollection.meta.removeDocMeta("remote-doc");
    try {
      remove();
      await vi.waitFor(() => expect(previousSignal.aborted).toBe(true));
      expect(lifecycle.state("remote-doc")).toBe("not-found");
      remove();
      expect(lifecycle.state("remote-doc")).toBe("not-found");
      add();
      await vi.waitFor(() =>
        expect(lifecycle.state("remote-doc")).toBe("creating"),
      );
      const pendingLeaf = docStates.get("remote-doc")!;
      remove();
      await vi.waitFor(() =>
        expect(lifecycle.state("remote-doc")).toBe("not-found"),
      );
      pendingLeaf.setValue({
        ...pendingLeaf.value,
        synced: true,
        ready: true,
        remoteMissing: false,
      });
      expect(lifecycle.state("remote-doc")).toBe("not-found");
      pendingLeaf.setValue({
        ...pendingLeaf.value,
        synced: false,
        ready: false,
      });
      add();
      await vi.waitFor(() =>
        expect(lifecycle.state("remote-doc")).toBe("creating"),
      );
      pendingLeaf.setValue({
        ...pendingLeaf.value,
        synced: true,
        ready: false,
      });
      expect(lifecycle.state("remote-doc")).toBe("creating");
      pendingLeaf.setValue({ ...pendingLeaf.value, ready: true });
      await vi.waitFor(() =>
        expect(lifecycle.state("remote-doc")).toBe("available"),
      );
      const replacementSignal = lifecycle.requestSignal("remote-doc");
      expect(replacementSignal).not.toBe(previousSignal);
      expect(replacementSignal.aborted).toBe(false);
      expect(previousSignal.aborted).toBe(true);
    } finally {
      store.dispose();
      lifecycle.dispose();
      workspace.rootYDoc.destroy();
      for (const leaf of workspace.leafDocs.values()) leaf.destroy();
    }
  });

  test("revives a new remote membership only after a non-missing leaf sync", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "existing-doc", title: "Existing", createDate: 1 },
    ]);
    const { docStates, lifecycle } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    lifecycle.markNotFound("existing-doc");
    lifecycle.markNotFound("new-member");

    workspace.docCollection.meta.setDocMeta("existing-doc", {
      title: "Still existing",
    });
    expect(lifecycle.state("existing-doc")).toBe("not-found");

    workspace.docCollection.meta.addDocMeta({
      id: "new-member",
      title: "New member",
      createDate: 2,
    } as any);
    await vi.waitFor(() => {
      expect(lifecycle.state("new-member")).toBe("creating");
    });

    docStates.get("new-member")?.setValue({
      loaded: true,
      ready: true,
      remoteMissing: true,
      synced: true,
      syncErrorMessage: null,
      syncRetrying: false,
      syncing: false,
      updating: false,
    });
    expect(lifecycle.state("new-member")).toBe("creating");

    docStates.get("new-member")?.setValue({
      loaded: true,
      ready: true,
      remoteMissing: false,
      synced: true,
      syncErrorMessage: null,
      syncRetrying: false,
      syncing: false,
      updating: false,
    });
    await vi.waitFor(() => {
      expect(lifecycle.state("new-member")).toBe("available");
    });
    expect(lifecycle.state("existing-doc")).toBe("not-found");
  });

  test("does not revive membership while peer sync is ahead of frontend apply", async () => {
    const workspace = createRootMetaWorkspace([]);
    const { docStates, lifecycle } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    lifecycle.markNotFound("ghost-member");

    workspace.docCollection.meta.addDocMeta({
      id: "ghost-member",
      title: "Ghost member",
      createDate: 1,
    } as any);
    await vi.waitFor(() => {
      expect(lifecycle.state("ghost-member")).toBe("creating");
    });

    // Peer has acknowledged the reconciliation and reports the remote as
    // present, but DocFrontend has not yet applied the resulting update into
    // the YDoc. Reviving the lifecycle here would expose a not-found doc as
    // available while the leaf is still rootless.
    docStates.get("ghost-member")?.setValue({
      loaded: true,
      ready: false,
      remoteMissing: false,
      synced: true,
      syncErrorMessage: null,
      syncRetrying: false,
      syncing: false,
      updating: false,
    });
    expect(lifecycle.state("ghost-member")).toBe("creating");

    // Once the apply job runs and the YDoc is populated, the lifecycle may
    // safely transition to available.
    docStates.get("ghost-member")?.setValue({
      loaded: true,
      ready: true,
      remoteMissing: false,
      synced: true,
      syncErrorMessage: null,
      syncRetrying: false,
      syncing: false,
      updating: false,
    });
    await vi.waitFor(() => {
      expect(lifecycle.state("ghost-member")).toBe("available");
    });
  });

  test("permanent root removal terminates cloud ids but preserves local lifecycle", () => {
    const cloudWorkspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Cloud", createDate: 1 },
    ]);
    const cloud = createStore({ flavour: "cloud", ...cloudWorkspace });
    const localWorkspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Local", createDate: 1 },
    ]);
    const local = createStore({ flavour: "local", ...localWorkspace });

    cloud.store.removeManyDocMeta(["doc-1"]);
    local.store.removeManyDocMeta(["doc-1"]);

    expect(cloud.lifecycle.state("doc-1")).toBe("not-found");
    expect(local.lifecycle.state("doc-1")).toBe("available");
  });

  test("server metadata readers use the shared index and never consult local properties", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Doc 1", createDate: 1 },
    ]);
    const nativeMetadata = metadata();
    const { hydrateModels, store, watchPropertyAllValues } = createStore({
      flavour: "cloud",
      metadataByDocId: { "doc-1": nativeMetadata },
      ...workspace,
    });

    const expected = {
      createdBy: "creator-1",
      updatedBy: "updater-1",
      journal: "2056-01-20",
      isTemplate: "true",
      primaryMode: "edgeless",
      pageWidth: "fullWidth",
      edgelessColorTheme: "dark",
      integrationType: "readwise",
    };
    for (const [key, value] of Object.entries(expected)) {
      await expect(
        firstValueFrom(store.watchNativeMetadataPropertyValues(key as never)),
      ).resolves.toEqual(new Map([["doc-1", value]]));
    }
    await expect(
      firstValueFrom(store.watchDocCreatedBySetting("doc-1")),
    ).resolves.toBe("creator-1");
    await expect(
      firstValueFrom(store.watchDocUpdatedBySetting("doc-1")),
    ).resolves.toBe("updater-1");
    await expect(
      firstValueFrom(store.watchDocJournalDateSetting("doc-1")),
    ).resolves.toBe("2056-01-20");
    await expect(
      firstValueFrom(store.watchDocTemplateStateSetting("doc-1")),
    ).resolves.toBe(true);
    await expect(
      firstValueFrom(store.watchDocTemplateClassification("doc-1")),
    ).resolves.toEqual({ category: "building-blocks", tags: ["project"] });
    await expect(
      firstValueFrom(store.watchDocPrimaryModeSetting("doc-1")),
    ).resolves.toBe("edgeless");
    await expect(
      firstValueFrom(store.watchDocPageWidthSetting("doc-1")),
    ).resolves.toBe("fullWidth");
    await expect(
      firstValueFrom(store.watchDocEdgelessColorThemeSetting("doc-1")),
    ).resolves.toBe("dark");
    await expect(
      firstValueFrom(store.watchDocIntegrationTypeSetting("doc-1")),
    ).resolves.toBe("readwise");

    expect(hydrateModels).not.toHaveBeenCalled();
    expect(watchPropertyAllValues).not.toHaveBeenCalled();
  });

  test("a confirmed index generation replaces values from an older full model", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Doc 1", createDate: 1 },
    ]);
    const stale = metadata();
    const current = metadata({
      system: { ...stale.system, createdBy: "creator-current" },
      presentation: { ...stale.presentation, primaryMode: "page" },
    });
    const currentClassification = { category: "journal-daily", tags: [] };
    const { store, lifecycle } = createStore({
      flavour: "cloud",
      metadataByDocId: { "doc-1": stale },
      indexMetadataByDocId: { "doc-1": current },
      gql: vi.fn(async () => ({
        documentMetadata: metadata({ template: currentClassification }),
      })),
      ...workspace,
    });

    await expect(
      firstValueFrom(store.watchNativeMetadataPropertyValues("createdBy")),
    ).resolves.toEqual(new Map([["doc-1", "creator-current"]]));
    await expect(
      firstValueFrom(store.watchDocCreatedBySetting("doc-1")),
    ).resolves.toBe("creator-current");
    await expect(
      firstValueFrom(store.watchDocPrimaryModeSetting("doc-1")),
    ).resolves.toBe("page");
    expect(store.getDocPrimaryModeSetting("doc-1")).toBe("page");

    lifecycle.beginCreating("doc-1");
    await expect(store.readDocTemplateClassification("doc-1")).resolves.toEqual(
      currentClassification,
    );
  });

  test("maps the canonical template none state to a non-template document", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Doc 1", createDate: 1 },
    ]);
    const { store } = createStore({
      flavour: "cloud",
      metadataByDocId: {
        "doc-1": metadata({ template: { state: "none" } }),
      },
      ...workspace,
    });

    await expect(
      firstValueFrom(store.watchNativeMetadataPropertyValues("isTemplate")),
    ).resolves.toEqual(new Map([["doc-1", undefined]]));
    await expect(
      firstValueFrom(store.watchDocTemplateStateSetting("doc-1")),
    ).resolves.toBe(false);
  });

  test("local metadata readers retain every current property-store field without GraphQL hydration", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Doc 1", createDate: 1 },
    ]);
    const { hydrateModels, store, watchPropertyAllValues } = createStore({
      flavour: "local",
      localPropertyValues: new Map([["doc-1", "local-creator"]]),
      localPropertiesByDocId: {
        "doc-1": {
          createdBy: "local-creator",
          updatedBy: "local-updater",
          journal: "2056-02-03",
          isTemplate: true,
          templateCategory: "building-blocks",
          templateTags: ["project"],
          primaryMode: "edgeless",
          pageWidth: "fullWidth",
          edgelessColorTheme: "dark",
          integrationType: "readwise",
        },
      },
      ...workspace,
    });

    await expect(
      firstValueFrom(store.watchNativeMetadataPropertyValues("createdBy")),
    ).resolves.toEqual(new Map([["doc-1", "local-creator"]]));
    await expect(
      firstValueFrom(store.watchDocCreatedBySetting("doc-1")),
    ).resolves.toBe("local-creator");
    await expect(
      firstValueFrom(store.watchDocUpdatedBySetting("doc-1")),
    ).resolves.toBe("local-updater");
    await expect(
      firstValueFrom(store.watchDocJournalDateSetting("doc-1")),
    ).resolves.toBe("2056-02-03");
    await expect(
      firstValueFrom(store.watchDocTemplateStateSetting("doc-1")),
    ).resolves.toBe(true);
    await expect(
      firstValueFrom(store.watchDocTemplateClassification("doc-1")),
    ).resolves.toEqual({ category: "building-blocks", tags: ["project"] });
    await expect(
      firstValueFrom(store.watchDocPrimaryModeSetting("doc-1")),
    ).resolves.toBe("edgeless");
    await expect(
      firstValueFrom(store.watchDocPageWidthSetting("doc-1")),
    ).resolves.toBe("fullWidth");
    await expect(
      firstValueFrom(store.watchDocEdgelessColorThemeSetting("doc-1")),
    ).resolves.toBe("dark");
    await expect(
      firstValueFrom(store.watchDocIntegrationTypeSetting("doc-1")),
    ).resolves.toBe("readwise");

    expect(watchPropertyAllValues).toHaveBeenCalledWith("createdBy");
    expect(hydrateModels).not.toHaveBeenCalled();
  });

  test("server workspaces persist through the bound WorkspaceServerService", async () => {
    const gql = vi.fn(async (_options: Record<string, unknown>) => ({
      setDocumentMetadata: {
        metadata: metadata({
          presentation: { primaryMode: "edgeless" },
        }),
      },
    }));
    const { store, waitForSynced, writeMetadataForDocument } = createStore({
      flavour: "cloud",
      gql,
    });

    await store.setDocPrimaryModeSetting("doc-1", "edgeless");

    expect(waitForSynced).not.toHaveBeenCalled();
    expect(gql).toHaveBeenCalledOnce();
    expect(gql.mock.calls[0]?.[0].variables).toEqual({
      docId: "doc-1",
      input: { primaryMode: "edgeless" },
      workspaceId: "ws-1",
    });
    expect(writeMetadataForDocument).toHaveBeenCalledExactlyOnceWith(
      "doc-1",
      expect.objectContaining({
        docId: "doc-1",
        presentation: { primaryMode: "edgeless" },
      }),
      "setDocumentMetadata",
    );
  });

  test("metadata mutation does not wait for an unloaded remote member leaf", async () => {
    const waitForSynced = vi.fn(async () => undefined);
    const gql = vi.fn(async () => ({
      setDocumentMetadata: { metadata: metadata() },
    }));
    const { lifecycle, store, writeMetadataForDocument } = createStore({
      flavour: "cloud",
      gql,
      waitForSynced,
    });

    lifecycle.beginCreating("doc-1");
    writeMetadataForDocument.mockImplementation(() => {
      lifecycle.requestSignal("doc-1");
    });
    await store.setDocTemplateClassification("doc-1", "building-blocks", [
      "decisions",
    ]);
    expect(waitForSynced).not.toHaveBeenCalled();
    expect(gql).toHaveBeenCalledOnce();
    expect(writeMetadataForDocument).not.toHaveBeenCalled();
  });

  test("server workspaces issue one mutation and surface document-not-found", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const notFound = new UserFriendlyError({
      status: 404,
      code: "DOC_NOT_FOUND",
      type: "NOT_FOUND",
      name: "DOC_NOT_FOUND",
      message: "not found: document",
    });
    const gql = vi.fn().mockRejectedValue(notFound);
    const { lifecycle, store, writeMetadataForDocument } = createStore({
      flavour: "cloud",
      gql,
    });

    try {
      await expect(
        store.setDocPageWidthSetting("doc-1", "fullWidth"),
      ).rejects.toBe(notFound);
      expect(gql).toHaveBeenCalledOnce();
      expect(writeMetadataForDocument).not.toHaveBeenCalled();
      expect(lifecycle.state("doc-1")).toBe("not-found");
      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        "[doc-metadata] native subsystem write failed",
        expect.objectContaining({
          docId: "doc-1",
          keys: ["pageWidth"],
          error: notFound,
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("server workspaces do not retry unrelated not-found errors", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const notFound = new UserFriendlyError({
      status: 404,
      code: "NOT_FOUND",
      type: "NOT_FOUND",
      name: "NOT_FOUND",
      message: "not found: workspace",
    });
    const gql = vi.fn().mockRejectedValue(notFound);
    const { store } = createStore({ flavour: "cloud", gql });

    try {
      await expect(
        store.setDocPageWidthSetting("doc-1", "fullWidth"),
      ).rejects.toBe(notFound);
      expect(gql).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        "[doc-metadata] native subsystem write failed",
        expect.objectContaining({
          docId: "doc-1",
          keys: ["pageWidth"],
          error: notFound,
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("local workspaces use the explicit offline projection and never require a server", async () => {
    const { applyOfflineSubsystemProjection, store } = createStore({
      flavour: "local",
    });

    await store.setDocJournalDateSetting("doc-1", "2056-01-20");

    expect(applyOfflineSubsystemProjection).toHaveBeenCalledExactlyOnceWith(
      "doc-1",
      { journal: "2056-01-20" },
    );
    let finish!: () => void;
    applyOfflineSubsystemProjection.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let acknowledged = false;
    const pending = store
      .setDocPrimaryModeSetting("doc-1", "edgeless")
      .then(() => {
        acknowledged = true;
      });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(applyOfflineSubsystemProjection).toHaveBeenLastCalledWith(
      "doc-1",
      { primaryMode: "edgeless" },
      true,
    );
    finish();
    await pending;
  });

  test("root trash metadata updates the live non-trash and trash projections", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-a", title: "Doc A", createDate: 1 },
      { id: "doc-b", title: "Doc B", createDate: 2 },
    ]);
    const { store } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    const nonTrashValues: string[][] = [];
    const trashValues: string[][] = [];
    const nonTrashSubscription = store
      .watchNonTrashDocIds()
      .subscribe((ids) => nonTrashValues.push(ids));
    const trashSubscription = store
      .watchTrashDocIds()
      .subscribe((ids) => trashValues.push(ids));

    try {
      expect(nonTrashValues.at(-1)).toEqual(["doc-a", "doc-b"]);
      expect(trashValues.at(-1)).toEqual([]);
      const pages = workspace.rootYDoc.getMap("meta").get("pages");
      expect(pages).toBeInstanceOf(Y.Array);
      expect((pages as Y.Array<unknown>).get(0)).toBeInstanceOf(Y.Map);
      store.setDocMeta("doc-a", { trash: true, trashDate: 42 });
      const firstDoc = (pages as Y.Array<Y.Map<unknown>>).get(
        0,
      ) as Y.Map<unknown>;
      expect(firstDoc.get("trash")).toBe(true);

      await vi.waitFor(() => {
        expect(nonTrashValues.at(-1)).toEqual(["doc-b"]);
        expect(trashValues.at(-1)).toEqual(["doc-a"]);
      });
    } finally {
      nonTrashSubscription.unsubscribe();
      trashSubscription.unsubscribe();
    }
  });

  test("bulk root trash metadata updates live projections in one operation", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-a", title: "Doc A", createDate: 1 },
      { id: "doc-b", title: "Doc B", createDate: 2 },
      { id: "doc-c", title: "Doc C", createDate: 3 },
    ]);
    const { store } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    const nonTrashValues: string[][] = [];
    const trashValues: string[][] = [];
    const nonTrashSubscription = store
      .watchNonTrashDocIds()
      .subscribe((ids) => nonTrashValues.push(ids));
    const trashSubscription = store
      .watchTrashDocIds()
      .subscribe((ids) => trashValues.push(ids));

    try {
      store.setManyDocMeta([
        { id: "doc-a", meta: { trash: true, trashDate: 100 } },
        { id: "doc-b", meta: { trash: true, trashDate: 100 } },
      ]);

      await vi.waitFor(() => {
        expect(nonTrashValues.at(-1)).toEqual(["doc-c"]);
        expect(trashValues.at(-1)).toEqual(["doc-a", "doc-b"]);
      });

      const pages = workspace.rootYDoc.getMap("meta").get("pages");
      expect(pages).toBeInstanceOf(Y.Array);
      const pageMaps = (pages as Y.Array<Y.Map<unknown>>).toArray();
      expect(pageMaps[0]?.get("trashDate")).toBe(100);
      expect(pageMaps[1]?.get("trashDate")).toBe(100);
      expect(pageMaps[2]?.get("trash")).toBeUndefined();
    } finally {
      nonTrashSubscription.unsubscribe();
      trashSubscription.unsubscribe();
    }
  });

  test("bulk root metadata removal updates live trash and all-docs projections", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-a", title: "Doc A", createDate: 1, trash: true },
      { id: "doc-b", title: "Doc B", createDate: 2, trash: true },
      { id: "doc-c", title: "Doc C", createDate: 3 },
    ]);
    const { store } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    const docIdValues: string[][] = [];
    const trashValues: string[][] = [];
    const docIdSubscription = store
      .watchDocIds()
      .subscribe((ids) => docIdValues.push(ids));
    const trashSubscription = store
      .watchTrashDocIds()
      .subscribe((ids) => trashValues.push(ids));

    try {
      expect(docIdValues.at(-1)).toEqual(["doc-a", "doc-b", "doc-c"]);
      expect(trashValues.at(-1)).toEqual(["doc-a", "doc-b"]);

      store.removeManyDocMeta(["doc-a", "doc-a", "missing-doc"]);

      await vi.waitFor(() => {
        expect(docIdValues.at(-1)).toEqual(["doc-b", "doc-c"]);
        expect(trashValues.at(-1)).toEqual(["doc-b"]);
      });

      const pages = workspace.rootYDoc.getMap("meta").get("pages");
      expect(pages).toBeInstanceOf(Y.Array);
      expect(
        (pages as Y.Array<Y.Map<unknown>>)
          .toArray()
          .map((page) => page.get("id")),
      ).toEqual(["doc-b", "doc-c"]);
    } finally {
      docIdSubscription.unsubscribe();
      trashSubscription.unsubscribe();
    }
  });

  test("document sync persists only the secured leaf in cloud and local workspaces", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-1", title: "Initial", createDate: 1 },
    ]);
    const cloud = createStore({
      flavour: "cloud",
      waitForSynced: vi.fn(async () => undefined),
      ...workspace,
    });
    await cloud.store.waitForDocSynced("doc-1");
    expect(cloud.saveDetachedUpdateAndWaitForSynced).toHaveBeenCalledOnce();
    expect(cloud.saveDetachedUpdateAndWaitForSynced).toHaveBeenCalledWith(
      "doc-1",
      expect.any(Uint8Array),
      undefined,
    );
    expect(cloud.waitForSynced).not.toHaveBeenCalled();

    const controller = new AbortController();
    await cloud.store.waitForDocSynced("doc-1", controller.signal);
    expect(cloud.saveDetachedUpdateAndWaitForSynced).toHaveBeenCalledWith(
      "doc-1",
      expect.any(Uint8Array),
      controller.signal,
    );

    const local = createStore({
      flavour: "local",
      waitForSynced: vi.fn(async () => undefined),
      ...workspace,
    });
    workspace.leafDocs
      .get("doc-1")!
      .getMap("blocks")
      .set("paragraph", "Native content");
    await local.store.waitForDocSynced("doc-1");
    expect(local.waitForSynced).not.toHaveBeenCalled();
    expect(local.saveDetachedUpdateAndWaitForSynced).toHaveBeenCalledOnce();
    const reopened = new Y.Doc();
    try {
      Y.applyUpdate(
        reopened,
        local.saveDetachedUpdateAndWaitForSynced.mock.calls[0]![1],
      );
      expect(reopened.getMap("blocks").get("paragraph")).toBe("Native content");
    } finally {
      reopened.destroy();
    }
  });

  test("effective title keeps a newer preview while the raw root snapshot remains stale", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-a", title: "Initial", createDate: 1 },
    ]);
    const { store } = createStore({
      flavour: "cloud",
      ...workspace,
    });
    const effective: string[] = [];
    const subscription = store
      .watchDocMeta("doc-a")
      .subscribe((meta) => effective.push(meta.title ?? ""));

    expect(store.getDocMetaSnapshot("doc-a").title).toBe("Initial");
    store.beginDocTitleIntent("doc-a", "Projektplanung");
    expect(effective.at(-1)).toBe("Projektplanung");

    store.setDocMeta("doc-a", { title: "Stale server replay" });
    expect(store.getDocMetaSnapshot("doc-a").title).toBe("Stale server replay");
    expect(effective.at(-1)).toBe("Projektplanung");

    store.setDocMeta("doc-a", { title: "Projektplanung" });
    expect(store.getDocMetaSnapshot("doc-a").title).toBe("Projektplanung");
    expect(effective.at(-1)).toBe("Projektplanung");
    await Promise.resolve();

    const previousPages = workspace.rootYDoc
      .getMap("meta")
      .get("pages") as Y.Array<Y.Map<unknown>>;
    const previousMeta = previousPages.get(0);
    const replacementPages = new Y.Array<Y.Map<unknown>>();
    const replacementMeta = new Y.Map<unknown>([
      ["id", "doc-a"],
      ["title", "Replacement title"],
      ["createDate", 1],
    ]);
    replacementPages.push([replacementMeta]);
    workspace.rootYDoc.getMap("meta").set("pages", replacementPages);

    expect(store.getDocMetaSnapshot("doc-a").title).toBe("Replacement title");
    expect(effective.at(-1)).toBe("Replacement title");
    previousMeta.set("title", "Detached title");
    expect(effective.at(-1)).toBe("Replacement title");
    replacementMeta.set("title", "Rebound title");
    expect(effective.at(-1)).toBe("Rebound title");
    subscription.unsubscribe();
  });

  test("native-local inline title acknowledgement persists the catalog title", async () => {
    const workspace = createRootMetaWorkspace([
      { id: "doc-a", title: "", createDate: 1 },
    ]);
    const { store, saveDetachedUpdateAndWaitForSynced } = createStore({
      flavour: "local",
      ...workspace,
    });
    const generation = store.beginDocTitleIntent("doc-a", "Local source");
    await DocsService.prototype.acknowledgeInlineDocTitle.call(
      { store } as unknown as DocsService,
      "doc-a",
      "Local source",
      generation,
    );
    expect(store.getDocMetaSnapshot("doc-a").title).toBe("Local source");
    expect(saveDetachedUpdateAndWaitForSynced).toHaveBeenCalledWith(
      "doc-a",
      expect.any(Uint8Array),
      undefined,
    );
  });

  test("server workspaces fail explicitly when no workspace server is bound", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { store } = createStore({ flavour: "cloud" });

    try {
      await expect(
        store.setDocPageWidthSetting("doc-1", "fullWidth"),
      ).rejects.toThrow(
        "Cannot persist native document metadata without a bound workspace server",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[doc-metadata] native subsystem write failed",
        expect.objectContaining({
          docId: "doc-1",
          keys: ["pageWidth"],
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

test("template inspection waits for source sync without saving a detached update or metadata", async () => {
  const waitForSynced = vi.fn(async () => {});
  const saveDetachedUpdateAndWaitForSynced = vi.fn(async () => {});
  const { store } = createStore({
    flavour: "cloud",
    waitForSynced,
    saveDetachedUpdateAndWaitForSynced,
  });
  const signal = new AbortController().signal;
  await store.waitForTemplateSourceSynced("readonly-source", signal);
  expect(waitForSynced).toHaveBeenCalledExactlyOnceWith(
    "readonly-source",
    signal,
  );
  expect(saveDetachedUpdateAndWaitForSynced).not.toHaveBeenCalled();
});
