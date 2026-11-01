// SPDX-License-Identifier: AGPL-3.0-or-later

import { filter, firstValueFrom, of } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { DocStorage, IndexerStorage } from "../../../storage";
import type { IndexerSyncStorage } from "../../../storage/indexer-sync";
import { IndexerSyncImpl, normalizeIndexerTitleField } from "../index";

type TestHarness = {
  processAcceptedJob(
    docId: string,
    indexVersion: number,
    signal?: AbortSignal,
  ): Promise<void>;
  indexDocJob(docId: string, indexVersion: number): Promise<void>;
  indexRootDocJob(): Promise<void>;
  status: {
    currentJob: string | null;
    errorMessage: string | null;
  };
};

function createIndexerHarness() {
  const refreshIfNeed = vi.fn(async () => {});
  const waitForConnected = vi.fn(async () => {});

  const doc = {
    spaceId: "root-doc",
  } as unknown as DocStorage;
  const indexer = {
    isReadonly: false,
    recommendRefreshInterval: 0,
    refreshIfNeed,
    connection: { waitForConnected },
  } as unknown as IndexerStorage;
  const indexerSync = {
    connection: { waitForConnected },
  } as unknown as IndexerSyncStorage;

  const impl = new IndexerSyncImpl(
    doc,
    {
      local: indexer,
      remotes: {},
    },
    indexerSync,
  );

  return {
    harness: impl as unknown as TestHarness,
    refreshIfNeed,
  };
}

function createRebuildLifecycle(options?: { failCommit?: boolean }) {
  const commit = Promise.withResolvers<void>();
  const refreshIfNeed = vi.fn(async () => {});
  const search = vi.fn(async () => ({
    pagination: { count: 0, limit: 10, skip: 0, hasMore: false },
    nodes: [],
  }));
  const search$ = vi.fn(() =>
    of({
      pagination: { count: 0, limit: 10, skip: 0, hasMore: false },
      nodes: [],
    }),
  );
  const completeRebuild = vi.fn(async () => {
    await commit.promise;
    if (options?.failCommit) throw new Error("snapshot transaction failed");
  });
  const failRebuild = vi.fn(async () => {});
  const waitForConnected = vi.fn(async () => {});
  const doc = {
    spaceId: "root-doc",
    connection: { waitForConnected },
    subscribeDocUpdate: vi.fn(() => () => {}),
    getDoc: vi.fn(async () => null),
  } as unknown as DocStorage;
  const indexer = {
    isReadonly: false,
    recommendRefreshInterval: 0,
    connection: { waitForConnected },
    indexVersion: vi.fn(async () => 30),
    indexState: vi.fn(async () => "rebuilding"),
    insert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteByQuery: vi.fn(async () => {}),
    refreshIfNeed,
    completeRebuild,
    failRebuild,
    search,
    search$,
  } as unknown as IndexerStorage;
  const indexerSync = {
    connection: { waitForConnected },
    clearDocIndexedClock: vi.fn(async () => {}),
  } as unknown as IndexerSyncStorage;
  const sync = new IndexerSyncImpl(
    doc,
    { local: indexer, remotes: {} },
    indexerSync,
  );

  return {
    commit,
    completeRebuild,
    failRebuild,
    refreshIfNeed,
    search,
    search$,
    sync,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeIndexerTitleField", () => {
  test("accepts legacy string-or-array title payloads without throwing", () => {
    expect(normalizeIndexerTitleField("Roadmap")).toBe("Roadmap");
    expect(normalizeIndexerTitleField(["Plan", "Fallback"])).toBe("Plan");
    expect(normalizeIndexerTitleField([42, "Recovered"])).toBe("Recovered");
    expect(normalizeIndexerTitleField(undefined)).toBeUndefined();
    expect(
      normalizeIndexerTitleField({ title: "invalid shape" }),
    ).toBeUndefined();
  });
});

describe("IndexerSyncImpl job handling", () => {
  test("quarantines document indexing failures instead of restarting the worker loop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { harness, refreshIfNeed } = createIndexerHarness();

    harness.indexDocJob = async () => {
      throw new ReferenceError("blocks is not defined");
    };
    harness.status.currentJob = "bad-doc";

    await expect(
      harness.processAcceptedJob("bad-doc", 30),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[storage:indexer] document indexing failed",
      expect.objectContaining({
        docId: "bad-doc",
        indexerVersion: 30,
        name: "ReferenceError",
        message: "blocks is not defined",
      }),
    );
    expect(harness.status.errorMessage).toBe("blocks is not defined");
    expect(harness.status.currentJob).toBeNull();
    expect(refreshIfNeed).toHaveBeenCalledTimes(1);
  });

  test("keeps root-document failures fatal but still completes the accepted job", async () => {
    const error = new Error("root index failed");
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { harness, refreshIfNeed } = createIndexerHarness();

    harness.indexRootDocJob = async () => {
      throw error;
    };
    harness.status.currentJob = "root-doc";

    await expect(harness.processAcceptedJob("root-doc", 30)).rejects.toThrow(
      "root index failed",
    );

    expect(logError).toHaveBeenCalledWith(
      "[storage:indexer] root document indexing failed",
      expect.objectContaining({
        name: "Error",
        message: "root index failed",
      }),
    );
    expect(harness.status.currentJob).toBeNull();
    expect(refreshIfNeed).toHaveBeenCalledTimes(1);
  });

  test("keeps local search fail-closed until the complete rebuild commits", async () => {
    const lifecycle = createRebuildLifecycle();
    lifecycle.sync.start();

    await firstValueFrom(
      lifecycle.sync.state$.pipe(
        filter(
          (state) =>
            state.availability === "rebuilding" &&
            lifecycle.completeRebuild.mock.calls.length === 1,
        ),
      ),
    );
    await expect(lifecycle.sync.search("doc", { type: "all" })).rejects.toThrow(
      "Search index temporarily unavailable (rebuilding)",
    );
    expect(lifecycle.search).not.toHaveBeenCalled();

    lifecycle.commit.resolve();
    await lifecycle.sync.waitForCompleted();
    await expect(
      lifecycle.sync.search("doc", { type: "all" }),
    ).resolves.toMatchObject({ nodes: [] });
    expect(lifecycle.search).toHaveBeenCalledTimes(1);

    await lifecycle.sync.stopAndWait();
    expect(lifecycle.refreshIfNeed).toHaveBeenCalled();
  });

  test("keeps reactive local searches subscribed across an atomic rebuild", async () => {
    const lifecycle = createRebuildLifecycle();
    lifecycle.sync.start();

    await firstValueFrom(
      lifecycle.sync.state$.pipe(
        filter(
          (state) =>
            state.availability === "rebuilding" &&
            lifecycle.completeRebuild.mock.calls.length === 1,
        ),
      ),
    );
    const result = firstValueFrom(
      lifecycle.sync.search$("doc", { type: "all" }),
    );
    await Promise.resolve();
    expect(lifecycle.search$).not.toHaveBeenCalled();

    lifecycle.commit.resolve();
    await expect(result).resolves.toMatchObject({ nodes: [] });
    expect(lifecycle.search$).toHaveBeenCalledTimes(1);

    await lifecycle.sync.stopAndWait();
  });

  test("marks a failed atomic rebuild and never exposes its partial index", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lifecycle = createRebuildLifecycle({ failCommit: true });
    lifecycle.sync.start();

    await firstValueFrom(
      lifecycle.sync.state$.pipe(
        filter(
          (state) =>
            state.availability === "rebuilding" &&
            lifecycle.completeRebuild.mock.calls.length === 1,
        ),
      ),
    );
    lifecycle.commit.resolve();
    const failed = await firstValueFrom(
      lifecycle.sync.state$.pipe(
        filter((state) => state.availability === "failed"),
      ),
    );

    expect(failed.completed).toBe(false);
    expect(failed.errorMessage).toContain("snapshot transaction failed");
    expect(lifecycle.failRebuild).toHaveBeenCalledTimes(1);
    await expect(lifecycle.sync.search("doc", { type: "all" })).rejects.toThrow(
      "Search index temporarily unavailable (failed)",
    );
    await expect(
      firstValueFrom(lifecycle.sync.search$("doc", { type: "all" })),
    ).rejects.toThrow("Search index temporarily unavailable (failed)");
    expect(lifecycle.search).not.toHaveBeenCalled();
    expect(lifecycle.search$).not.toHaveBeenCalled();

    await lifecycle.sync.stopAndWait();
  });
});
