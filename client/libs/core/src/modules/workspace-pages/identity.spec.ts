// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { parseWorkspacePageKey, workspacePageKey } from "./identity";

describe("Workspace Page identity", () => {
  test("keeps overlapping document and Database IDs collision-safe", () => {
    expect(workspacePageKey({ kind: "document", id: "shared" })).toBe(
      "document:shared",
    );
    expect(workspacePageKey({ kind: "database", id: "shared" })).toBe(
      "database:shared",
    );
  });

  test("round-trips IDs containing separators and rejects malformed keys", () => {
    expect(parseWorkspacePageKey("database:tenant:database-1")).toEqual({
      kind: "database",
      id: "tenant:database-1",
    });
    expect(parseWorkspacePageKey("page:database-1")).toBeNull();
    expect(parseWorkspacePageKey("database:")).toBeNull();
    expect(parseWorkspacePageKey("database-1")).toBeNull();
  });
});
