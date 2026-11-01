// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { selectDefaultWorkspace } from "./model";

describe("desktop workspace default selection", () => {
  const workspaces = [{ id: "alpha" }, { id: "beta" }];

  test("prefers the last workspace only while it remains readable", () => {
    expect(selectDefaultWorkspace(workspaces, "beta")?.id).toBe("beta");
    expect(selectDefaultWorkspace(workspaces, "stale")?.id).toBe("alpha");
  });

  test("returns a terminating empty state instead of inventing a workspace", () => {
    expect(selectDefaultWorkspace([], "stale")).toBeNull();
  });
});
