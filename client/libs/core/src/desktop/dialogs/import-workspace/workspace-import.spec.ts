// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import {
  isWorkspaceImportPollingStatus,
  prepareWorkspaceImport,
  uploadWorkspaceImportParts,
  workspaceImportProgress,
} from "./workspace-import";

describe("workspace import upload adapter", () => {
  test("hashes a file and every bounded part without changing the bytes", async () => {
    const prepared = await prepareWorkspaceImport(
      new File(["abcdef"], "workspace.db"),
      { partSizeBytes: 3 },
    );

    expect(prepared).toEqual({
      sourceHash:
        "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
      sourceSizeBytes: 6,
      parts: [
        {
          partNumber: 1,
          sizeBytes: 3,
          contentHash:
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
        {
          partNumber: 2,
          sizeBytes: 3,
          contentHash:
            "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34",
        },
      ],
    });
  });

  test("uploads signed parts serially and reports byte progress", async () => {
    const activeCalls: number[] = [];
    let active = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      active += 1;
      activeCalls.push(active);
      expect(init?.method).toBe("PUT");
      await Promise.resolve();
      active -= 1;
      return new Response(null, { status: 204 });
    });
    const progress: number[] = [];

    await uploadWorkspaceImportParts(
      new File(["abcdef"], "workspace.db"),
      [
        { partNumber: 1, sizeBytes: 3, contentHash: "a", uploadUrl: "/1" },
        { partNumber: 2, sizeBytes: 3, contentHash: "b", uploadUrl: "/2" },
      ],
      {
        fetcher: fetcher as typeof fetch,
        onProgress: (current) => progress.push(current),
      },
    );

    expect(activeCalls).toEqual([1, 1]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([3, 6]);
  });

  test("fails on an incomplete manifest instead of publishing partial bytes", async () => {
    await expect(
      uploadWorkspaceImportParts(
        new File(["abcdef"], "workspace.db"),
        [
          {
            partNumber: 1,
            sizeBytes: 3,
            contentHash: "a",
            uploadUrl: "/1",
          },
        ],
        { fetcher: vi.fn(async () => new Response(null, { status: 204 })) },
      ),
    ).rejects.toThrow("manifest does not match");
  });

  test("derives bounded progress and polls only durable active states", () => {
    expect(workspaceImportProgress(4, 8)).toBe(50);
    expect(workspaceImportProgress(12, 8)).toBe(100);
    expect(workspaceImportProgress(1, 0)).toBe(0);
    expect(isWorkspaceImportPollingStatus("queued")).toBe(true);
    expect(isWorkspaceImportPollingStatus("running")).toBe(true);
    expect(isWorkspaceImportPollingStatus("previewed")).toBe(false);
  });
});
