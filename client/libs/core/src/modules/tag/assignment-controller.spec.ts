// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import { WorkspaceTagAssignmentController } from "./assignment-controller";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("WorkspaceTagAssignmentController", () => {
  test("coalesces two unawaited selections into one stable full-value commit", async () => {
    const commit = vi.fn(async (ids: string[]) => ids);
    const controller = new WorkspaceTagAssignmentController([], commit);

    controller.select("tag-a");
    controller.select("tag-b");
    await controller.flush();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(["tag-a", "tag-b"]);
    expect(controller.state$.value).toMatchObject({
      confirmedIds: ["tag-a", "tag-b"],
      projectedIds: ["tag-a", "tag-b"],
      status: "idle",
    });
  });

  test("commits the last select-then-deselect target", async () => {
    const commit = vi.fn(async (ids: string[]) => ids);
    const controller = new WorkspaceTagAssignmentController([], commit);

    controller.select("tag-a");
    controller.deselect("tag-a");
    await controller.flush();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith([]);
    expect(controller.state$.value.confirmedIds).toEqual([]);
  });

  test("serializes the latest ordered target while a commit is in flight", async () => {
    const first = deferred<string[]>();
    const commit = vi
      .fn<(ids: string[]) => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (ids) => ids);
    const controller = new WorkspaceTagAssignmentController(["tag-a"], commit);

    controller.select("tag-b");
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    controller.select("tag-c");
    controller.deselect("tag-a");
    first.resolve(["tag-a", "tag-b"]);
    await controller.flush();

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]?.[0]).toEqual(["tag-a", "tag-b"]);
    expect(commit.mock.calls[1]?.[0]).toEqual(["tag-b", "tag-c"]);
    expect(controller.state$.value).toMatchObject({
      confirmedIds: ["tag-b", "tag-c"],
      projectedIds: ["tag-b", "tag-c"],
      status: "idle",
    });
  });

  test("rolls back on failure and retries the failed target exactly once", async () => {
    const failure = new Error("write failed");
    const commit = vi
      .fn<(ids: string[]) => Promise<string[]>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(["confirmed", "tag-a"]);
    const controller = new WorkspaceTagAssignmentController(
      ["confirmed"],
      commit,
    );

    controller.select("tag-a");
    await expect(controller.flush()).rejects.toBe(failure);
    expect(controller.state$.value).toMatchObject({
      confirmedIds: ["confirmed"],
      projectedIds: ["confirmed"],
      failedTargetIds: ["confirmed", "tag-a"],
      status: "error",
    });

    controller.retry();
    controller.retry();
    await controller.flush();

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[0]).toEqual(["confirmed", "tag-a"]);
    expect(controller.state$.value.status).toBe("idle");
  });

  test("uses an external confirmation as the newest rollback baseline", async () => {
    const pending = deferred<string[]>();
    const commit = vi.fn(() => pending.promise);
    const controller = new WorkspaceTagAssignmentController(["old"], commit);

    controller.select("local");
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    controller.setConfirmedIds(["external"]);
    expect(controller.state$.value.projectedIds).toEqual(["old", "local"]);

    pending.reject(new Error("conflict"));
    await expect(controller.flush()).rejects.toThrow("conflict");
    expect(controller.state$.value).toMatchObject({
      confirmedIds: ["external"],
      projectedIds: ["external"],
      failedTargetIds: ["old", "local"],
    });
  });

  test("lets the response for an in-flight request win over an external baseline", async () => {
    const pending = deferred<string[]>();
    const controller = new WorkspaceTagAssignmentController(
      ["old"],
      () => pending.promise,
    );

    controller.select("local");
    await vi.waitFor(() =>
      expect(controller.state$.value.status).toBe("saving"),
    );
    controller.setConfirmedIds(["external"]);
    pending.resolve(["server"]);
    await controller.flush();

    expect(controller.state$.value).toMatchObject({
      confirmedIds: ["server"],
      projectedIds: ["server"],
      status: "idle",
    });
  });
});
