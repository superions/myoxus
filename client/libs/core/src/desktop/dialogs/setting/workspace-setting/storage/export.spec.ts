// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { describe, expect, test, vi } from "vitest";

import { requestObsidianVault } from "./export";

describe("Obsidian vault workspace export", () => {
  test("downloads opaque authenticated ZIP bytes from the server owner", async () => {
    const zip = new Blob(["PK vault"], { type: "application/zip" });
    const fetcher = vi.fn(async () => new Response(zip, { status: 200 }));

    const result = await requestObsidianVault("workspace/id", fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/workspaces/workspace%2Fid/export/obsidian-vault",
      { credentials: "include" },
    );
    expect(result.type).toBe("application/zip");
    expect(await result.text()).toBe("PK vault");
  });

  test("rejects failed exports instead of downloading partial content", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 409 }));
    await expect(requestObsidianVault("workspace", fetcher)).rejects.toThrow(
      "Vault export failed (409)",
    );
  });
});
