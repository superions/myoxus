// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    all: () => Object.fromEntries(values),
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
    del: (key: string) => values.delete(key),
    clear: () => values.clear(),
    flush: vi.fn(async () => {}),
  };
});
vi.mock("../../src/main/shared-storage/storage", () => ({
  globalStateStorage: storage,
  globalCacheStorage: storage,
}));
import {
  globalStateUpdates$,
  sharedStorageHandlers,
} from "../../src/main/shared-storage/handlers";

beforeEach(() => {
  storage.values.clear();
  storage.flush.mockReset().mockResolvedValue(undefined);
});

test("a failed retained-request deletion is restored before confirmed reads and queued writes", async () => {
  const pending = {
    requestId: "retained-request",
    workspaceId: "known-result",
  };
  storage.set("workspace-creation:pending", pending);
  const flush = Promise.withResolvers<void>();
  storage.flush.mockImplementationOnce(() => flush.promise);
  const updates: unknown[] = [];
  const subscription = globalStateUpdates$.subscribe((value) =>
    updates.push(value),
  );
  const pendingOperations: Promise<unknown>[] = [];
  try {
    const deletion = expect(
      sharedStorageHandlers.delGlobalState(
        undefined as never,
        "workspace-creation:pending",
      ),
    ).rejects.toThrow("disk full");
    pendingOperations.push(deletion);
    await vi.waitFor(() => expect(storage.flush).toHaveBeenCalledOnce());
    let readFinished = false;
    const snapshot = sharedStorageHandlers.getAllGlobalState().then((value) => {
      readFinished = true;
      return value;
    });
    pendingOperations.push(snapshot);
    const next = sharedStorageHandlers.setGlobalState(
      undefined as never,
      "unrelated",
      "saved",
    );
    pendingOperations.push(next);
    // Existing non-IPC Main writers remain independent and must not be rolled back.
    storage.set("selectedServerId", "another-server");
    expect(readFinished).toBe(false);
    flush.reject(new Error("disk full"));
    await deletion;
    expect((await snapshot)["workspace-creation:pending"]).toEqual(pending);
    await next;
    expect(await sharedStorageHandlers.getAllGlobalState()).toMatchObject({
      "workspace-creation:pending": pending,
      selectedServerId: "another-server",
      unrelated: "saved",
    });
    expect(updates).toEqual([
      { unrelated: { v: "saved", r: 1, s: undefined } },
    ]);
  } finally {
    // A failed assertion must not strand the module's serialized writer and
    // poison another case in the shared Electron test process.
    flush.reject(new Error("disk full"));
    await Promise.allSettled(pendingOperations);
    subscription.unsubscribe();
  }
});

test("failed state replacement and clear preserve their previous values without publishing an ACK", async () => {
  const updates: unknown[] = [];
  const subscription = globalStateUpdates$.subscribe((value) =>
    updates.push(value),
  );
  try {
    storage.set("request", { id: "old" });
    storage.set("other", "keep");
    storage.flush.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      sharedStorageHandlers.setGlobalState(undefined as never, "request", {
        id: "new",
      }),
    ).rejects.toThrow("write failed");
    expect(await sharedStorageHandlers.getAllGlobalState()).toEqual({
      request: { id: "old" },
      other: "keep",
    });
    storage.flush.mockRejectedValueOnce(new Error("clear failed"));
    await expect(
      sharedStorageHandlers.clearGlobalState(undefined as never),
    ).rejects.toThrow("clear failed");
    expect(await sharedStorageHandlers.getAllGlobalState()).toEqual({
      request: { id: "old" },
      other: "keep",
    });
    expect(updates).toEqual([]);
  } finally {
    subscription.unsubscribe();
  }
});

test("server registration publishes confirmed authority and serializes concurrent registry changes", async () => {
  const config = {
    type: "Standalone",
    serverName: "Owned",
    features: [],
    oauthProviders: [],
    credentialsRequirement: { password: { minLength: 8, maxLength: 128 } },
    version: "0.41.36",
  };
  const alpha = { id: "alpha", baseUrl: "http://127.0.0.1:3101" };
  const beta = { id: "beta", baseUrl: "http://127.0.0.1:3102" };
  const updates: unknown[] = [];
  const subscription = globalStateUpdates$.subscribe((change) =>
    updates.push(change),
  );
  const flush = Promise.withResolvers<void>();
  const pending: Promise<unknown>[] = [];
  try {
    storage.flush.mockImplementationOnce(() => flush.promise);
    const first = sharedStorageHandlers.mutateServerRegistry(
      undefined as never,
      { type: "add", server: alpha, config },
    );
    pending.push(first);
    await vi.waitFor(() => expect(storage.flush).toHaveBeenCalledOnce());
    const second = sharedStorageHandlers.mutateServerRegistry(
      undefined as never,
      { type: "add", server: beta, config },
    );
    pending.push(second);
    expect(updates).toEqual([]);
    flush.resolve();
    await Promise.all([first, second]);
    expect(storage.get("serverList")).toEqual([alpha, beta]);
    expect(updates).toEqual([
      expect.objectContaining({
        "serverConfig:alpha": expect.objectContaining({ v: config }),
        serverList: expect.objectContaining({ v: [alpha] }),
        selectedServerId: expect.objectContaining({ v: "alpha" }),
      }),
      expect.objectContaining({
        serverList: expect.objectContaining({ v: [alpha, beta] }),
      }),
    ]);
    await expect(
      sharedStorageHandlers.mutateServerRegistry(undefined as never, {
        type: "add",
        server: { id: "duplicate", baseUrl: alpha.baseUrl },
        config,
      }),
    ).rejects.toThrow("already exists");
    await Promise.all([
      sharedStorageHandlers.mutateServerRegistry(undefined as never, {
        type: "remove",
        id: "alpha",
      }),
      sharedStorageHandlers.mutateServerRegistry(undefined as never, {
        type: "add",
        server: { id: "gamma", baseUrl: "http://127.0.0.1:3103" },
        config,
      }),
    ]);
    expect(storage.get("serverList")).toEqual([
      beta,
      { id: "gamma", baseUrl: "http://127.0.0.1:3103" },
    ]);
    const before = storage.all();
    const count = updates.length;
    storage.flush.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      sharedStorageHandlers.mutateServerRegistry(undefined as never, {
        type: "remove",
        id: "gamma",
      }),
    ).rejects.toThrow("disk full");
    expect(storage.all()).toEqual(before);
    expect(updates).toHaveLength(count);
    await expect(
      sharedStorageHandlers.mutateServerRegistry(undefined as never, {
        type: "add",
        server: { id: "unsafe", baseUrl: "http://public.example" },
        config,
      }),
    ).rejects.toThrow("Invalid configured server");
  } finally {
    flush.resolve();
    await Promise.allSettled(pending);
    subscription.unsubscribe();
  }
});
