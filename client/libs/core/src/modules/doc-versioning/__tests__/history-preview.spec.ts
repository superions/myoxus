// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { createElement, StrictMode, type PropsWithChildren } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { Text } from "@virgultum/editor/store";
import type { RootBlockModel } from "@virgultum/editor/model";
import type { DocumentVersion } from "@myoxus/core/modules/doc-versioning/types";
import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { FetchService, GraphQLService } from "@myoxus/core/modules/server";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { notify } from "@myoxus/ui-facade";
import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import {
  getInitialPageHistorySnapshotId,
  mergeHistorySnapshots,
  type DocHistory,
  useDocumentHistory,
  useDocumentVersioningOverview,
} from "@myoxus/core/modules/doc-versioning/history-data";

const services = vi.hoisted(() => new Map<unknown, unknown>());
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: (token: unknown) => {
    if (!services.has(token)) throw new Error("Unexpected history service");
    return services.get(token);
  },
}));

import {
  HistorySnapshotUnavailableError,
  useRestorePage,
  useSnapshotPage,
} from "../history-preview";

const workspaces: WorkspaceImpl[] = [];
function workspace(title: string) {
  const collection = new WorkspaceImpl({
    id: "workspace-1",
    rootDoc: new YDoc(),
  });
  collection.meta.initialize();
  const store = collection.createDoc("doc-1").getStore();
  store.load();
  store.addBlock("myoxus:page", { title: new Text(title) });
  workspaces.push(collection);
  return { collection, store };
}

function wrapper({ children }: PropsWithChildren) {
  return createElement(
    StrictMode,
    null,
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      children,
    ),
  );
}

function title(store: ReturnType<typeof useSnapshotPage>["page"]) {
  return String((store?.root as RootBlockModel | null)?.props.title ?? "");
}

beforeEach(() => {
  services.set(WorkspaceService, {
    workspace: { meta: { id: "workspace-1" } },
  });
  services.set(WorkspacesService, {
    getWorkspaceFlavourProvider: () => undefined,
  });
  services.set(FeatureFlagService, undefined);
});
afterEach(() => {
  cleanup();
  for (const collection of workspaces.splice(0)) {
    collection.dispose();
    collection.doc.destroy();
  }
  services.clear();
  vi.restoreAllMocks();
});

describe("history snapshot reads", () => {
  test("merges overlapping pages once per snapshot, preserving bigint order at equal timestamps", () => {
    const history = (snapshotId: string, timestamp: string): DocHistory => ({
      snapshotId,
      timestamp,
      cursor: `cursor-${snapshotId}`,
      id: "doc-1",
      editor: null,
      origin: null,
    });
    const a = history("9007199254740992", "2026-09-06T00:00:00Z");
    const b = history("9007199254740993", a.timestamp);
    const c = history("4", "2026-09-06T00:00:01Z");
    expect(mergeHistorySnapshots([a, b, c, a, b])).toEqual([c, b, a]);
  });

  test("passes the named filter into the shared paginated query", async () => {
    const gql = vi.fn().mockResolvedValue({
      workspace: {
        histories: [
          {
            id: "doc-1",
            snapshotId: "41",
            cursor: "2026-09-24T10:00:00Z|41",
            timestamp: "2026-09-24T10:00:00Z",
            origin: "manual",
            editor: null,
          },
        ],
      },
    });
    services.set(GraphQLService, { gql });
    const { result } = renderHook(
      () => useDocumentHistory("workspace-1", "doc-1", true),
      { wrapper },
    );
    await waitFor(() => expect(result.current[0]).toHaveLength(1));
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ op: "listHistory" }),
        variables: {
          workspaceId: "workspace-1",
          pageDocId: "doc-1",
          cursor: undefined,
          take: 10,
          namedOnly: true,
        },
      }),
    );
  });

  test("selects a named snapshot outside pagination without rounding or a timestamp fallback", () => {
    const version: DocumentVersion = {
      id: "version-1",
      docId: "doc-1",
      workspaceId: "workspace-1",
      docHistoryId: "9007199254740993",
      versionNo: 1,
      label: "reviewed",
      description: null,
      createdBy: "user",
      createdAt: "2026-09-06T00:00:01Z",
      isPinned: false,
      event: "manual",
      kind: "manual",
      isProtected: false,
      policyId: null,
      contentHash: null,
    };
    expect(getInitialPageHistorySnapshotId([], [version])).toBe(
      "9007199254740993",
    );
  });

  test("decodes isolated readonly content and never relabels a stale selection", async () => {
    const live = workspace("Live document");
    const a = encodeStateAsUpdate(workspace("Snapshot A").store.spaceDoc);
    const b = encodeStateAsUpdate(workspace("Snapshot B").store.spaceDoc);
    let resolveB!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(toArrayBuffer(a)))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveB = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(toArrayBuffer(a)));
    services.set(FetchService, {
      fetch,
      get framework() {
        throw new Error("Snapshot keys must not traverse the service graph");
      },
    });
    const { result, rerender } = renderHook(
      ({ id }) => useSnapshotPage(live.collection, "doc-1", id),
      {
        initialProps: { id: "9007199254740993" },
        wrapper,
      },
    );
    await waitFor(() => expect(title(result.current.page)).toBe("Snapshot A"));
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/docs/doc-1/histories/by-id/9007199254740993",
      { throwOnHttpError: false },
    );
    expect(result.current.page?.workspace).not.toBe(live.collection);
    expect(result.current.page?.id).toBe("doc-1");
    expect(result.current.page?.readonly).toBe(true);
    expect(
      result.current.page?.workspace.meta.getDocMeta("doc-1")?.title,
    ).not.toBe("Live document");

    rerender({ id: "2" });
    expect(result.current.page).toBeUndefined();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    rerender({ id: "3" });
    expect(result.current.page).toBeUndefined();
    await waitFor(() => expect(title(result.current.page)).toBe("Snapshot A"));
    await act(async () => {
      resolveB(new Response(toArrayBuffer(b)));
    });
    expect(title(result.current.page)).toBe("Snapshot A");
    expect(title(live.store)).toBe("Live document");
    expect(result.current.error).toBeUndefined();
  });

  test("revalidates the same history ID and hides its previous workspace projection", async () => {
    const live = workspace("Live");
    const oldBytes = encodeStateAsUpdate(
      workspace("Before Move").store.spaceDoc,
    );
    const newBytes = encodeStateAsUpdate(
      workspace("After Undo").store.spaceDoc,
    );
    let resolve!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(toArrayBuffer(oldBytes)))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
    services.set(FetchService, { fetch });
    const cache = new Map();
    const sharedWrapper = ({ children }: PropsWithChildren) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children);
    const first = renderHook(
      () => useSnapshotPage(live.collection, "doc-1", "41"),
      { wrapper: sharedWrapper },
    );
    await waitFor(() =>
      expect(title(first.result.current.page)).toBe("Before Move"),
    );
    first.unmount();
    const second = renderHook(
      () => useSnapshotPage(live.collection, "doc-1", "41"),
      { wrapper: sharedWrapper },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(second.result.current.page).toBeUndefined();
    expect(second.result.current.isLoading).toBe(true);
    await act(async () => resolve(new Response(toArrayBuffer(newBytes))));
    await waitFor(() =>
      expect(title(second.result.current.page)).toBe("After Undo"),
    );
    expect(title(live.store)).toBe("Live");
  });

  test("snapshot and named-version failures remain errors and recover through retry", async () => {
    const notification = vi
      .spyOn(notify, "error")
      .mockImplementation(() => "history-test");
    const live = workspace("Live");
    const bytes = encodeStateAsUpdate(
      workspace("Recovered snapshot").store.spaceDoc,
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(toArrayBuffer(bytes)));
    const gql = vi
      .fn()
      .mockRejectedValueOnce(new Error("document not found"))
      .mockResolvedValueOnce({ documentVersions: [] });
    services.set(FetchService, { fetch });
    services.set(GraphQLService, { gql });
    const snapshot = renderHook(
      () => useSnapshotPage(live.collection, "doc-1", "11"),
      {
        wrapper: ({ children }: PropsWithChildren) =>
          createElement(
            SWRConfigProvider,
            null,
            createElement(
              SWRConfig,
              { value: { provider: () => new Map(), dedupingInterval: 0 } },
              children,
            ),
          ),
      },
    );
    const versions = renderHook(
      () =>
        useDocumentVersioningOverview(
          services.get(GraphQLService) as GraphQLService,
          "workspace-1",
          "doc-1",
        ),
      { wrapper },
    );
    await waitFor(() =>
      expect(snapshot.result.current.error).toBeInstanceOf(
        HistorySnapshotUnavailableError,
      ),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/docs/doc-1/histories/by-id/11",
      { throwOnHttpError: false },
    );
    expect(notification).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(versions.result.current[2].error).toBeInstanceOf(Error),
    );
    expect(versions.result.current[1]).toBe(false);
    expect(snapshot.result.current.page).toBeUndefined();
    await act(async () => {
      await snapshot.result.current.retry();
    });
    await waitFor(() =>
      expect(snapshot.result.current.error).toBeInstanceOf(Error),
    );
    expect(snapshot.result.current.error).not.toBeInstanceOf(
      HistorySnapshotUnavailableError,
    );
    expect(notification).not.toHaveBeenCalled();
    await act(async () => {
      await snapshot.result.current.retry();
      await versions.result.current[2].retry();
    });
    await waitFor(() =>
      expect(title(snapshot.result.current.page)).toBe("Recovered snapshot"),
    );
    expect(snapshot.result.current.error).toBeUndefined();
    expect(versions.result.current[2].error).toBeUndefined();
    expect(gql).toHaveBeenLastCalledWith({
      query: expect.objectContaining({ op: "documentVersioningOverview" }),
      variables: { workspaceId: "workspace-1", docId: "doc-1" },
    });
  });

  test("revalidates cached named references when a history viewer mounts again", async () => {
    const version = (id: string): DocumentVersion => ({
      id,
      docId: "doc-1",
      workspaceId: "workspace-1",
      docHistoryId: id === "version-1" ? "41" : "42",
      versionNo: id === "version-1" ? 1 : 2,
      label: id,
      description: null,
      createdBy: "user-1",
      createdAt: "2026-09-24T10:00:00Z",
      isPinned: false,
      event: "manual",
      kind: "manual",
      isProtected: false,
      policyId: null,
      contentHash: null,
    });
    let response = [version("version-1")];
    const gql = vi.fn(async () => ({ documentVersions: response }));
    services.set(GraphQLService, { gql });
    const cache = new Map();
    const sharedWrapper = ({ children }: PropsWithChildren) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children);

    const first = renderHook(
      () =>
        useDocumentVersioningOverview(
          services.get(GraphQLService) as GraphQLService,
          "workspace-1",
          "doc-1",
        ),
      { wrapper: sharedWrapper },
    );
    await waitFor(() =>
      expect(
        first.result.current[0]?.documentVersions.map(({ id }) => id),
      ).toEqual(["version-1"]),
    );
    const firstRequestCount = gql.mock.calls.length;
    first.unmount();

    response = [version("version-2"), version("version-1")];
    const second = renderHook(
      () =>
        useDocumentVersioningOverview(
          services.get(GraphQLService) as GraphQLService,
          "workspace-1",
          "doc-1",
        ),
      { wrapper: sharedWrapper },
    );
    await waitFor(() =>
      expect(gql.mock.calls.length).toBeGreaterThan(firstRequestCount),
    );
    await waitFor(() =>
      expect(
        second.result.current[0]?.documentVersions.map(({ id }) => id),
      ).toEqual(["version-2", "version-1"]),
    );
    expect(second.result.current[1]).toBe(false);
  });
});

describe("shared overview scope and visibility", () => {
  test("a quick remount refreshes cached list and overview inside SWR's dedupe window", async () => {
    let historyId = "1";
    const service = {
      gql: vi.fn(async ({ query }) =>
        query.op === "documentVersioningOverview"
          ? { documentVersions: [{ id: historyId }] }
          : {
              workspace: {
                histories: [
                  { snapshotId: historyId, timestamp: "2026-10-11T10:00:00Z" },
                ],
              },
            },
      ),
    };
    services.set(GraphQLService, service);
    const cache = new Map();
    const config = { provider: () => cache, dedupingInterval: 2000 };
    const HistoryReads = () => {
      const [histories] = useDocumentHistory("workspace", "doc");
      const [overview] = useDocumentVersioningOverview(
        service as never,
        "workspace",
        "doc",
      );
      return createElement(
        "output",
        { "data-testid": "history-reads" },
        `${histories.map((h) => h.snapshotId).join()}|${overview?.documentVersions.map((v) => v.id).join()}`,
      );
    };
    const surface = (visible: boolean) =>
      createElement(
        SWRConfig,
        { value: config },
        visible ? createElement(HistoryReads) : null,
      );
    vi.useFakeTimers();
    try {
      const view = render(surface(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(view.getByTestId("history-reads").textContent).toBe("1|1");
      // Keep the provider mounted: the product closes its history surface,
      // not the app-wide cache and its pending/completed request registry.
      view.rerender(surface(false));
      historyId = "2";
      view.rerender(surface(true));
      await act(async () => {
        // SWR defers cached mounting reads to a frame; remain well inside its
        // normal two-second dedupe window rather than checking before that frame.
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(view.getByTestId("history-reads").textContent).toBe("2|2");
      expect(service.gql).toHaveBeenCalledTimes(4);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  test("late overview responses cannot replace another document, workspace or service", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const service = {
      gql: vi.fn(({ variables }) =>
        variables.docId === "old"
          ? old
          : Promise.resolve({
              documentVersions: [{ id: variables.docId }],
              workspace: { id: variables.workspaceId },
            }),
      ),
    };
    const successor = {
      gql: vi
        .fn()
        .mockResolvedValue({ documentVersions: [{ id: "other-server" }] }),
    };
    Object.defineProperty(service, "framework", {
      enumerable: true,
      get() {
        throw new Error("History keys must not traverse the service graph");
      },
    });
    const cache = new Map();
    const sharedWrapper = ({ children }: PropsWithChildren) =>
      createElement(
        SWRConfig,
        { value: { provider: () => cache, dedupingInterval: 0 } },
        children,
      );
    const view = renderHook(
      ({ graphql, workspaceId, docId }) =>
        useDocumentVersioningOverview(
          graphql as never,
          workspaceId,
          docId,
          true,
        ),
      {
        initialProps: { graphql: service, workspaceId: "first", docId: "old" },
        wrapper: sharedWrapper,
      },
    );
    await waitFor(() => expect(service.gql).toHaveBeenCalled());
    view.rerender({ graphql: service, workspaceId: "second", docId: "new" });
    await waitFor(() =>
      expect(view.result.current[0]?.documentVersions[0]?.id).toBe("new"),
    );
    await act(async () => resolveOld({ documentVersions: [{ id: "old" }] }));
    expect(view.result.current[0]?.documentVersions[0]?.id).toBe("new");
    view.rerender({ graphql: successor, workspaceId: "second", docId: "new" });
    await waitFor(() =>
      expect(view.result.current[0]?.documentVersions[0]?.id).toBe(
        "other-server",
      ),
    );
    expect(successor.gql).toHaveBeenCalledWith({
      query: expect.anything(),
      variables: { workspaceId: "second", docId: "new" },
    });
  });
});

describe("shared history restore consumer", () => {
  test("pins confirmation to its revision, preserves reference IDs and retries only after preparing again", async () => {
    const waitForSynced = vi.fn().mockResolvedValue(undefined);
    const hydrateMetadata = vi.fn().mockResolvedValue(undefined);
    const refreshHistory = vi.fn().mockResolvedValue(undefined);
    const requests: Array<{ op: string; variables: unknown }> = [];
    let revision = "7";
    let failRestore = true;
    const gql = vi.fn(async ({ query, variables }) => {
      requests.push({ op: query.op, variables });
      if (query.op === "documentHistoryRevision") {
        return { documentHistoryRevision: revision };
      }
      if (query.op === "restoreDocumentVersion") {
        if (failRestore) throw new Error("Restore response lost");
        return { restoreDocumentVersion: { id: "restored-reference" } };
      }
      if (query.op === "recoverDoc") return { recoverDoc: true };
      throw new Error(`Unexpected operation ${query.op}`);
    });
    services.set(WorkspaceService, {
      workspace: { id: "workspace-1", engine: { doc: { waitForSynced } } },
    });
    services.set(GraphQLService, { gql });
    services.set(DocumentMetadataCacheService, { hydrateMetadata });
    const { result } = renderHook(() =>
      useRestorePage("doc-1", refreshHistory),
    );
    let prepared!: NonNullable<
      Awaited<ReturnType<typeof result.current.prepare>>
    >;
    await act(async () => {
      prepared = (await result.current.prepare({ versionId: "alias-2" }))!;
    });
    expect(requests.map((request) => request.op)).toEqual([
      "documentHistoryRevision",
    ]);
    revision = "8";
    await act(async () => {
      await expect(result.current.onRestore(prepared)).rejects.toThrow(
        "Restore response lost",
      );
    });
    expect(result.current.restoreError).toBe("Restore response lost");
    expect(
      requests.filter((request) => request.op === "restoreDocumentVersion"),
    ).toEqual([
      {
        op: "restoreDocumentVersion",
        variables: { id: "alias-2", expectedRevision: "7" },
      },
    ]);
    expect(refreshHistory).toHaveBeenCalledOnce();
    expect(hydrateMetadata).toHaveBeenCalledWith("doc-1", undefined, {
      refresh: true,
    });
    await act(async () => {
      prepared = (await result.current.prepare({ versionId: "alias-2" }))!;
    });
    expect(prepared.expectedRevision).toBe("8");
    expect(
      requests.filter((request) => request.op === "restoreDocumentVersion"),
    ).toHaveLength(1);
    failRestore = false;
    await act(async () => {
      expect(await result.current.onRestore(prepared)).toMatchObject({
        refreshError: null,
      });
    });
    expect(result.current.restoreError).toBeNull();
    await act(async () => {
      const unnamed = await result.current.prepare({
        snapshotId: "9007199254740993",
      });
      expect(await result.current.onRestore(unnamed!)).toMatchObject({
        refreshError: null,
      });
    });
    expect(requests.filter((request) => request.op === "recoverDoc")).toEqual([
      {
        op: "recoverDoc",
        variables: {
          workspaceId: "workspace-1",
          docId: "doc-1",
          snapshotId: "9007199254740993",
          expectedRevision: "8",
        },
      },
    ]);
    expect(
      requests.filter((request) => request.op === "restoreDocumentVersion"),
    ).toHaveLength(2);
    expect(waitForSynced.mock.calls.map(([id]) => id)).toEqual(
      Array.from({ length: 6 }, () => ["workspace-1", "doc-1"]).flat(),
    );

    refreshHistory.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await act(async () => {
      prepared = (await result.current.prepare({ versionId: "alias-2" }))!;
      const committed = await result.current.onRestore(prepared);
      expect(committed.refreshError).toEqual(
        expect.objectContaining({ message: "Refresh unavailable" }),
      );
    });
    expect(result.current.restoreError).toBeNull();
    expect(
      requests.filter((request) => request.op === "restoreDocumentVersion"),
    ).toHaveLength(3);
  });
});
