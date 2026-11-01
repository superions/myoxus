import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clientUpdateCacheResetStore,
  configureClientUpdateCacheResetAdapter,
  resetClientUpdateCacheResetStore,
  resetRegisteredCloudCaches,
} from "./cache-reset";

const cloud = vi.hoisted(() => ({
  deleteRegisteredCloudDatabases: vi.fn(),
  inspectRegisteredCloudDatabases: vi.fn(),
  readAppliedClientUpdateState: vi.fn(),
}));

vi.mock("@myoxus/storage/cloud", () => cloud);

const prepare = vi.fn();

describe("client update Cloud cache reset", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetClientUpdateCacheResetStore();
    configureClientUpdateCacheResetAdapter({ prepare });
    cloud.readAppliedClientUpdateState.mockResolvedValue({
      cloudDatabaseRegistryInitialized: true,
      registeredCloudDatabases: [{ name: "cloud:workspace:a", peerIds: [] }],
    });
    cloud.inspectRegisteredCloudDatabases.mockResolvedValue({
      existingDatabases: ["cloud:workspace:a"],
      pendingBlobs: 0,
      pendingDocuments: 0,
    });
    cloud.deleteRegisteredCloudDatabases.mockResolvedValue(undefined);
    prepare.mockResolvedValue({
      ready: true,
      pendingBlobs: 0,
      pendingDocuments: 0,
    });
  });

  test("requires an explicit retry after an inspection failure", async () => {
    cloud.inspectRegisteredCloudDatabases.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const reset = resetRegisteredCloudCaches(
      "https://example.test",
      new AbortController().signal,
    );

    await vi.waitFor(() =>
      expect(clientUpdateCacheResetStore.getSnapshot()).toEqual({
        status: "failed",
      }),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(cloud.deleteRegisteredCloudDatabases).not.toHaveBeenCalled();

    clientUpdateCacheResetStore.retry();
    await reset;

    expect(cloud.deleteRegisteredCloudDatabases).toHaveBeenCalledWith([
      "cloud:workspace:a",
    ]);
    expect(clientUpdateCacheResetStore.getSnapshot()).toEqual({
      status: "completed",
    });
  });

  test("keeps pending persisted data away from worker close and deletion", async () => {
    vi.useFakeTimers();
    cloud.inspectRegisteredCloudDatabases
      .mockResolvedValueOnce({
        existingDatabases: ["cloud:workspace:a"],
        pendingBlobs: 1,
        pendingDocuments: 2,
      })
      .mockResolvedValueOnce({
        existingDatabases: ["cloud:workspace:a"],
        pendingBlobs: 0,
        pendingDocuments: 0,
      });
    const reset = resetRegisteredCloudCaches(
      "https://example.test",
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(clientUpdateCacheResetStore.getSnapshot()).toEqual({
      status: "waiting",
      pendingBlobs: 1,
      pendingDocuments: 2,
    });
    expect(prepare).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await reset;
    expect(prepare).toHaveBeenCalledOnce();
    expect(cloud.deleteRegisteredCloudDatabases).toHaveBeenCalledOnce();
  });
});
