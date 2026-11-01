// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {
  AssistanceMode,
  Permission,
  WorkspaceCreationStatus,
  WorkspaceInitialContent,
  WorkspaceInitialContentPolicy,
  createWorkspaceMutation,
  type CreateWorkspaceInput,
  ServerDeploymentType,
} from "@myoxus/graphql";
import type { SharedStorageSnapshot } from "@myoxus/desktop-api-contract";
import { DebugLogger } from "@myoxus/debug";
import { DesktopApiService } from "../../desktop-api";
import type { WorkspaceMetadata } from "../../workspace";
import { LiveData, MemoryMemento } from "@myoxus/infra";
import { Doc as YDoc, applyUpdate } from "yjs";
import { AuthService } from "../../server";
import * as localCapability from "../../workspace/local-workspace-capability";
import {
  localWorkspaceInitialContentPolicyKey,
  localWorkspaceAssistanceKey,
} from "../../workspace/metadata";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CloudWorkspaceFlavourProvider } from "./cloud";
import {
  LOCAL_WORKSPACE_GLOBAL_STATE_KEY,
  LOCAL_WORKSPACE_LOCAL_STORAGE_KEY,
  LocalWorkspaceFlavourProvider,
} from "./local";

beforeEach(() => {
  // Node 26's localStorage getter is not Happy DOM's browser storage.
  vi.stubGlobal("localStorage", new window.Storage());
});
afterEach(() => vi.unstubAllGlobals());

describe("workspace storage configuration", () => {
  test("cloud workspaces keep current local storage and only the cloud remote", () => {
    const server = {
      id: "synthetic-server",
      serverMetadata: { baseUrl: "https://synthetic.invalid" },
      config$: {
        value: { type: ServerDeploymentType.Standalone, features: [] },
      },
      scope: {
        get: vi.fn(() => ({})),
        eventBus: { on: vi.fn(() => vi.fn()) },
      },
    };
    const provider = new CloudWorkspaceFlavourProvider(
      {} as never,
      server as never,
    );

    const options = provider.getEngineWorkerInitOptions("synthetic-workspace");

    expect(Object.keys(options.remotes)).toEqual(["cloud:synthetic-server"]);
    expect(options.local.doc?.name).toMatch(/^(IndexedDB|Sqlite)DocStorage$/);
    expect(options.local.blob?.name).toMatch(/^(IndexedDB|Sqlite)BlobStorage$/);
    expect(JSON.stringify(options)).not.toContain("V1");
    expect(JSON.stringify(options)).not.toContain('"v1"');
  });

  test("local workspaces keep current local storage and have no sync remote", () => {
    const framework = { get: vi.fn() };
    const provider = new LocalWorkspaceFlavourProvider(framework as never);

    const options = provider.getEngineWorkerInitOptions("synthetic-workspace");

    expect(options.remotes).toEqual({});
    expect(options.local.doc?.name).toMatch(/^(IndexedDB|Sqlite)DocStorage$/);
    expect(options.local.blob?.name).toMatch(/^(IndexedDB|Sqlite)BlobStorage$/);
    expect(JSON.stringify(options)).not.toContain("V1");
  });
});

test.each([false])(
  "canonical cloud creation does not construct local root storage or invoke a legacy initializer (Project=%s)",
  async (includeProject) => {
    const account$ = new LiveData<{ id: string } | null>({ id: "actor-a" });
    const input: CreateWorkspaceInput = {
      name: "Empty",
      project: includeProject
        ? {
            package: {
              id: "myoxus.assistant.project.simple_project",
              version: "1.2.0",
              digest: "native-package-pin",
            },
            answers: { name: { kind: "text", value: "Explicit Project" } },
            locale: "en",
            clientVersion: 1,
          }
        : undefined,
      initialContent: WorkspaceInitialContent.Empty,
      assistanceMode: AssistanceMode.Manual,
      requestId: "11111111-1111-4111-8111-111111111111",
      assistantConfirmation: {
        identity: { id: "source", version: "1.0.0", digest: "pin" },
        answers: {},
        planDigest: "plan",
      },
    };
    const gql = vi.fn(async () => ({
      createWorkspace: {
        id: "workspace-a",
        name: "Empty",
        initialized: true,
        role: Permission.Owner,
        workspaceType: "UserOwned",
        owner: { id: "actor-a" },
        initialContentPolicy: WorkspaceInitialContentPolicy.Empty,
        creation: {
          requestId: input.requestId,
          workspaceId: "workspace-a",
          acceptedPlan: null,
          projectSetup: null,
          status: WorkspaceCreationStatus.Ready,
          rootReady: true,
          tasksReady: true,
          tasksDatabaseId: "tasks-a",
          assistanceSaved: true,
          retryRequired: false,
          reasonCode: null,
        },
      },
    }));
    const server = {
      id: "server-a",
      scope: {
        get: (token: unknown) =>
          token === AuthService ? { session: { account$ } } : { gql },
        eventBus: { on: () => () => {} },
      },
    };
    const provider = new CloudWorkspaceFlavourProvider(
      new MemoryMemento(),
      server as never,
    );
    const revalidate = vi
      .spyOn(provider, "revalidate")
      .mockImplementation(() => {});
    const constructDoc = vi.fn(function () {
      throw new Error("local root must not be constructed");
    });
    const constructBlob = vi.fn(function () {
      throw new Error("local blobs must not be constructed");
    });
    provider.DocStorageType = constructDoc as never;
    provider.BlobStorageType = constructBlob as never;
    const initial = vi.fn();
    try {
      const metadata = await provider.createWorkspace(initial, {
        kind: "cloud-empty",
        input,
      });
      expect(metadata).toMatchObject({
        id: "workspace-a",
        name: "Empty",
        role: Permission.Owner,
        isOwner: true,
        initialContentPolicy: WorkspaceInitialContentPolicy.Empty,
      });
      expect(gql).toHaveBeenCalledWith({
        query: createWorkspaceMutation,
        variables: { input },
      });
      expect(initial).not.toHaveBeenCalled();
      expect(constructDoc).not.toHaveBeenCalled();
      expect(constructBlob).not.toHaveBeenCalled();
    } finally {
      revalidate.mockRestore();
      provider.dispose();
    }
  },
);

test("local Empty policy save failure happens before scan-visible storage or publication", async () => {
  const capability = vi
    .spyOn(localCapability, "canUseLocalWorkspaces")
    .mockReturnValue(true);
  const state = new MemoryMemento();
  const flush = Promise.withResolvers<void>();
  const persist = vi.fn(() => flush.promise);
  Object.assign(state, { setConfirmed: persist });
  const provider = new LocalWorkspaceFlavourProvider({
    get: () => state,
  } as never);
  const doc = vi.fn(function () {
    throw new Error("storage must not start");
  });
  const blob = vi.fn(function () {
    throw new Error("storage must not start");
  });
  provider.DocStorageType = doc as never;
  provider.BlobStorageType = blob as never;
  const publish = vi.spyOn(provider.notifyChannel, "postMessage");
  const initial = vi.fn();
  try {
    const creation = provider.createWorkspace(initial, {
      kind: "local-empty",
      name: "Empty",
      assistanceMode: AssistanceMode.Guided,
    });
    const rejected = expect(creation).rejects.toThrow("storage full");
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(doc).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
    flush.reject(new Error("storage full"));
    await rejected;
    expect(doc).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
    expect(initial).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    provider.notifyChannel.close();
    capability.mockRestore();
  }
});

test("local Empty persists its policy before root construction and materializes only the technical root", async () => {
  const capability = vi
    .spyOn(localCapability, "canUseLocalWorkspaces")
    .mockReturnValue(true);
  const state = new MemoryMemento();
  const provider = new LocalWorkspaceFlavourProvider({
    get: () => state,
  } as never);
  const updates: Array<{ docId: string; bin: Uint8Array }> = [];
  const docConnection = {
    connect: vi.fn(),
    waitForConnected: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
  const blobConnection = {
    connect: vi.fn(),
    waitForConnected: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
  provider.DocStorageType = vi.fn(function (options: { id: string }) {
    expect(state.get(localWorkspaceInitialContentPolicyKey(options.id))).toBe(
      WorkspaceInitialContentPolicy.Empty,
    );
    expect(state.get(localWorkspaceAssistanceKey(options.id))).toBe(
      AssistanceMode.Guided,
    );
    return {
      connection: docConnection,
      pushDocUpdate: async (update: { docId: string; bin: Uint8Array }) => {
        updates.push(update);
      },
    };
  }) as never;
  provider.BlobStorageType = vi.fn(function () {
    return { connection: blobConnection };
  }) as never;
  const initial = vi.fn();
  let root: YDoc | undefined;
  const before = localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  try {
    const metadata = await provider.createWorkspace(initial, {
      kind: "local-empty",
      name: "Native Empty",
      assistanceMode: AssistanceMode.Guided,
    });
    expect(initial).not.toHaveBeenCalled();
    expect(updates.map((update) => update.docId)).toEqual([metadata.id]);
    root = new YDoc({ guid: metadata.id });
    applyUpdate(root, updates[0].bin);
    expect(root.getMap("meta").get("name")).toBe("Native Empty");
    expect(root.getSubdocs().size).toBe(0);
    expect(metadata.initialContentPolicy).toBe(
      WorkspaceInitialContentPolicy.Empty,
    );
    expect(docConnection.disconnect).toHaveBeenCalledOnce();
    expect(blobConnection.disconnect).toHaveBeenCalledOnce();
  } finally {
    root?.destroy();
    provider.notifyChannel.close();
    capability.mockRestore();
    if (before === null)
      localStorage.removeItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
    else localStorage.setItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY, before);
  }
});

class MetadataChannel extends EventTarget {
  static channels = new Set<MetadataChannel>();
  constructor(readonly name: string) {
    super();
    MetadataChannel.channels.add(this);
  }
  postMessage(data: unknown) {
    for (const channel of MetadataChannel.channels)
      if (channel !== this && channel.name === this.name)
        channel.dispatchEvent(new MessageEvent("message", { data }));
  }
  close() {
    MetadataChannel.channels.delete(this);
  }
}
function nativeMetadataFixture(read: () => Promise<SharedStorageSnapshot>) {
  vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, isElectron: true });
  vi.stubGlobal("BroadcastChannel", MetadataChannel);
  const cached = vi.fn(() => undefined);
  const api = {
    sharedStorage: { globalState: { ready: Promise.resolve(), get: cached } },
    handler: {
      workspace: { listLocalWorkspaceIds: vi.fn(async () => ["native-empty"]) },
      sharedStorage: {
        getAllGlobalState: vi.fn(read),
        setGlobalState: vi.fn(async () => {}),
      },
    },
  };
  const provider = new LocalWorkspaceFlavourProvider({
    get: (token: unknown) =>
      token === DesktopApiService ? api : { get: cached },
  } as never);
  const values: WorkspaceMetadata[][] = [];
  const subscription = provider.workspaces$.subscribe((value) =>
    values.push(value),
  );
  return {
    provider,
    api,
    cached,
    values,
    dispose: () => {
      subscription.unsubscribe();
      provider.notifyChannel.close();
    },
  };
}
const nativeEmptySnapshot = (): SharedStorageSnapshot => ({
  [LOCAL_WORKSPACE_GLOBAL_STATE_KEY]: ["native-empty"],
  [localWorkspaceInitialContentPolicyKey("native-empty")]:
    WorkspaceInitialContentPolicy.Empty,
});

test("native restart publishes Empty metadata from one confirmed snapshot despite an empty optimistic cache", async () => {
  const snapshot = Promise.withResolvers<SharedStorageSnapshot>();
  const previous = localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  localStorage.removeItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  const f = nativeMetadataFixture(() => snapshot.promise);
  try {
    await vi.waitFor(() =>
      expect(
        f.api.handler.sharedStorage.getAllGlobalState,
      ).toHaveBeenCalledOnce(),
    );
    expect(f.provider.isRevalidating$.value).toBe(true);
    expect(
      f.values
        .flat()
        .some(
          (value) =>
            value.initialContentPolicy ===
            WorkspaceInitialContentPolicy.LegacyDefaults,
        ),
    ).toBe(false);
    snapshot.resolve(nativeEmptySnapshot());
    await vi.waitFor(() =>
      expect(f.provider.workspaces$.value).toEqual([
        {
          id: "native-empty",
          flavour: "local",
          initialContentPolicy: WorkspaceInitialContentPolicy.Empty,
        },
      ]),
    );
    expect(f.provider.isRevalidating$.value).toBe(false);
    expect(f.cached).not.toHaveBeenCalled();
    expect(
      f.api.handler.sharedStorage.getAllGlobalState,
    ).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
    vi.unstubAllGlobals();
    if (previous !== null)
      localStorage.setItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY, previous);
  }
});

test("a failed confirmed native read stays loading without publishing Legacy metadata and revalidate can retry", async () => {
  const previous = localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  localStorage.removeItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  const logger = vi
    .spyOn(DebugLogger.prototype, "error")
    .mockImplementation(() => {});
  const read = vi
    .fn<() => Promise<SharedStorageSnapshot>>()
    .mockRejectedValueOnce(new Error("Main snapshot unavailable"))
    .mockResolvedValue(nativeEmptySnapshot());
  const f = nativeMetadataFixture(read);
  try {
    await vi.waitFor(() =>
      expect(logger).toHaveBeenCalledWith(
        "Failed to read confirmed local Workspace metadata",
        expect.any(Error),
      ),
    );
    expect(f.provider.workspaces$.value).toEqual([]);
    expect(f.provider.isRevalidating$.value).toBe(true);
    expect(f.values.flat()).toEqual([]);
    f.provider.revalidate();
    await vi.waitFor(() =>
      expect(f.provider.workspaces$.value[0]?.initialContentPolicy).toBe(
        WorkspaceInitialContentPolicy.Empty,
      ),
    );
    expect(f.provider.isRevalidating$.value).toBe(false);
    expect(
      f.values
        .flat()
        .every(
          (value) =>
            value.initialContentPolicy === WorkspaceInitialContentPolicy.Empty,
        ),
    ).toBe(true);
    expect(f.cached).not.toHaveBeenCalled();
  } finally {
    f.dispose();
    logger.mockRestore();
    vi.unstubAllGlobals();
    if (previous !== null)
      localStorage.setItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY, previous);
  }
});

test("newer native metadata snapshots and disposal fence delayed earlier emissions", async () => {
  const previous = localStorage.getItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  localStorage.removeItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY);
  const read = vi.fn(async () => nativeEmptySnapshot());
  const f = nativeMetadataFixture(read);
  try {
    await vi.waitFor(() =>
      expect(f.provider.isRevalidating$.value).toBe(false),
    );
    const old = Promise.withResolvers<SharedStorageSnapshot>();
    const latest = Promise.withResolvers<SharedStorageSnapshot>();
    read
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => latest.promise);
    f.provider.revalidate();
    f.provider.revalidate();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    latest.resolve(nativeEmptySnapshot());
    await vi.waitFor(() =>
      expect(f.provider.isRevalidating$.value).toBe(false),
    );
    old.resolve({ [LOCAL_WORKSPACE_GLOBAL_STATE_KEY]: ["native-empty"] });
    await old.promise;
    expect(f.provider.workspaces$.value[0]?.initialContentPolicy).toBe(
      WorkspaceInitialContentPolicy.Empty,
    );
    const disposed = Promise.withResolvers<SharedStorageSnapshot>();
    read.mockImplementationOnce(() => disposed.promise);
    f.provider.revalidate();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    const count = f.values.length;
    f.dispose();
    disposed.resolve({ [LOCAL_WORKSPACE_GLOBAL_STATE_KEY]: ["late-root"] });
    await disposed.promise;
    expect(f.values).toHaveLength(count);
  } finally {
    f.dispose();
    vi.unstubAllGlobals();
    if (previous !== null)
      localStorage.setItem(LOCAL_WORKSPACE_LOCAL_STORAGE_KEY, previous);
  }
});
