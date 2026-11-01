// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    all: () => Object.fromEntries(values),
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
