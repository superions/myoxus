// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ClientUpdateControl,
  ClientUpdateGateSnapshot,
} from "@myoxus/storage";
import type { AppliedClientUpdateState } from "@myoxus/storage/cloud";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ControllerReloadCoordinator } from "../service-worker-update";
import {
  type ClientUpdateCompletionSource,
  startClientUpdateCompletionCoordinator,
} from "./completion";

const persistence = vi.hoisted(() => ({
  state: {
    observedOperationId: null,
    appliedCompletionOperationId: null,
    appliedCacheEpoch: 0,
    resetInProgressEpoch: null,
    cloudDatabaseRegistryInitialized: true,
    registeredCloudDatabases: [],
  } as AppliedClientUpdateState,
}));

const cacheReset = vi.hoisted(() => ({
  reset: vi.fn(async () => {}),
  resetStore: vi.fn(),
}));

vi.mock("@myoxus/storage/cloud", () => ({
  readAppliedClientUpdateState: vi.fn(async () => ({ ...persistence.state })),
  updateAppliedClientUpdateState: vi.fn(
    async (
      _endpoint: string,
      update: (current: AppliedClientUpdateState) => AppliedClientUpdateState,
    ) => {
      persistence.state = update({ ...persistence.state });
      return { ...persistence.state };
    },
  ),
}));

vi.mock("./cache-reset", () => ({
  resetRegisteredCloudCaches: cacheReset.reset,
  resetClientUpdateCacheResetStore: cacheReset.resetStore,
}));

function control(
  phase: ClientUpdateControl["phase"],
  overrides: Partial<ClientUpdateControl> = {},
): ClientUpdateControl {
  return {
    schemaVersion: 1,
    stateId: `state-${phase}`,
    phase,
    operationId: phase === "normal" ? null : "operation-a",
    maxAttempts: phase === "limited" ? 1 : null,
    retryAfterMs: null,
    completion: null,
    requiredWebBuildId: null,
    cacheEpoch: 0,
    updatedAt: "2026-07-26T00:00:00Z",
    ...overrides,
  };
}

class Source implements ClientUpdateCompletionSource {
  private snapshot: ClientUpdateGateSnapshot = {
    status: "loading",
    control: null,
    remainingAttempts: 0,
  };
  private readonly listeners = new Set<() => void>();

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(control: ClientUpdateControl) {
    this.snapshot = {
      status: "ready",
      control,
      remainingAttempts: control.phase === "normal" ? null : 0,
    };
    for (const listener of this.listeners) listener();
  }
}

function createReload(): ControllerReloadCoordinator {
  return {
    controllerChanged: vi.fn(),
    requestReload: vi.fn(),
    setReloadBlocked: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("client update completion coordinator", () => {
  beforeEach(() => {
    persistence.state = {
      observedOperationId: null,
      appliedCompletionOperationId: null,
      appliedCacheEpoch: 0,
      resetInProgressEpoch: null,
      cloudDatabaseRegistryInitialized: true,
      registeredCloudDatabases: [],
    };
    cacheReset.reset.mockReset();
    cacheReset.reset.mockResolvedValue(undefined);
    cacheReset.resetStore.mockReset();
  });

  test("reloads every runtime that observed the completed operation exactly once", async () => {
    const source = new Source();
    const reload = createReload();
    const updateServiceWorker = vi.fn(async () => {});
    const stop = startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker,
      getCurrentBuildId: vi.fn(async () => "current-build"),
    });

    source.set(control("suspended"));
    await vi.waitFor(() =>
      expect(persistence.state.observedOperationId).toBe("operation-a"),
    );
    source.set(
      control("normal", {
        completion: { operationId: "operation-a", action: "reload" },
      }),
    );

    await vi.waitFor(() => expect(reload.requestReload).toHaveBeenCalledOnce());
    expect(updateServiceWorker).toHaveBeenCalledOnce();
    expect(persistence.state.appliedCompletionOperationId).toBe("operation-a");

    source.set(
      control("normal", {
        stateId: "state-repeated",
        completion: { operationId: "operation-a", action: "reload" },
      }),
    );
    await Promise.resolve();
    expect(reload.requestReload).toHaveBeenCalledOnce();
    stop();
  });

  test("reloads a stale build even when this runtime missed the operation", async () => {
    const source = new Source();
    const reload = createReload();
    startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker: vi.fn(async () => {}),
      getCurrentBuildId: vi.fn(async () => "old-build"),
    });

    source.set(
      control("normal", {
        completion: { operationId: "operation-a", action: "reload" },
        requiredWebBuildId: "new-build",
      }),
    );

    await vi.waitFor(() => expect(reload.requestReload).toHaveBeenCalledOnce());
  });

  test("blocks controller takeover until success or abort returns to normal", async () => {
    const source = new Source();
    const reload = createReload();
    startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker: vi.fn(async () => {}),
      getCurrentBuildId: vi.fn(async () => null),
    });

    source.set(control("failed"));
    await vi.waitFor(() =>
      expect(reload.setReloadBlocked).toHaveBeenLastCalledWith(true),
    );
    source.set(
      control("normal", {
        completion: { operationId: "operation-a", action: "none" },
      }),
    );

    await vi.waitFor(() =>
      expect(reload.setReloadBlocked).toHaveBeenLastCalledWith(false),
    );
    expect(reload.requestReload).not.toHaveBeenCalled();
    expect(persistence.state.appliedCompletionOperationId).toBe("operation-a");
  });

  test("does not mark a completion when service-worker update fails", async () => {
    const source = new Source();
    const reload = createReload();
    const onError = vi.fn();
    startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker: vi.fn(async () => {
        throw new Error("update failed");
      }),
      getCurrentBuildId: vi.fn(async () => null),
      onError,
    });

    source.set(control("limited"));
    await vi.waitFor(() =>
      expect(persistence.state.observedOperationId).toBe("operation-a"),
    );
    source.set(
      control("normal", {
        completion: { operationId: "operation-a", action: "reload" },
      }),
    );

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(persistence.state.appliedCompletionOperationId).toBeNull();
    expect(reload.requestReload).not.toHaveBeenCalled();
  });

  test("fences a cache epoch until reset succeeds and then reloads", async () => {
    const source = new Source();
    const reload = createReload();
    startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker: vi.fn(async () => {}),
      getCurrentBuildId: vi.fn(async () => null),
    });

    source.set(
      control("normal", {
        cacheEpoch: 3,
        completion: {
          operationId: "operation-reset",
          action: "reset_local_cache",
        },
      }),
    );

    await vi.waitFor(() => expect(cacheReset.reset).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reload.requestReload).toHaveBeenCalledOnce());
    expect(persistence.state).toMatchObject({
      appliedCacheEpoch: 3,
      resetInProgressEpoch: null,
      appliedCompletionOperationId: "operation-reset",
    });
  });

  test("keeps the reset fence when cache deletion fails", async () => {
    cacheReset.reset.mockRejectedValueOnce(new Error("blocked"));
    const source = new Source();
    const reload = createReload();
    const onError = vi.fn();
    startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker: vi.fn(async () => {}),
      getCurrentBuildId: vi.fn(async () => null),
      onError,
    });

    source.set(control("normal", { cacheEpoch: 4 }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(persistence.state).toMatchObject({
      appliedCacheEpoch: 0,
      resetInProgressEpoch: 4,
    });
    expect(reload.requestReload).not.toHaveBeenCalled();
  });

  test("resumes a durable reset fence after a new page runtime starts", async () => {
    persistence.state = {
      ...persistence.state,
      appliedCacheEpoch: 2,
      resetInProgressEpoch: 5,
    };
    const source = new Source();
    const reload = createReload();
    startClientUpdateCompletionCoordinator({
      source,
      endpoint: "https://example.test",
      reload,
      updateServiceWorker: vi.fn(async () => {}),
      getCurrentBuildId: vi.fn(async () => null),
    });

    source.set(control("normal", { cacheEpoch: 2 }));

    await vi.waitFor(() => expect(cacheReset.reset).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reload.requestReload).toHaveBeenCalledOnce());
    expect(persistence.state).toMatchObject({
      appliedCacheEpoch: 5,
      resetInProgressEpoch: null,
    });
  });
});
