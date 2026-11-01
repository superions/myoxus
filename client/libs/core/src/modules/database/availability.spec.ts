// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  canUseServerBackedDatabases,
  getDatabaseWorkspaceAvailability,
} from "./availability";

describe("database workspace availability", () => {
  test("allows only workspaces with a non-local server binding", () => {
    expect(
      getDatabaseWorkspaceAvailability({
        flavour: "myoxus-cloud",
        id: "workspace-1",
      }),
    ).toEqual({
      reason: "server-backed",
      serverWorkspaceId: "workspace-1",
      status: "available",
    });
    expect(
      getDatabaseWorkspaceAvailability({ flavour: "local", id: "local-1" }),
    ).toEqual({
      reason: "local-workspace",
      serverWorkspaceId: null,
      status: "unavailable",
    });
    expect(getDatabaseWorkspaceAvailability({ flavour: "myoxus-cloud" }))
      .toMatchInlineSnapshot(`
        {
          "reason": "missing-server-binding",
          "serverWorkspaceId": null,
          "status": "unavailable",
        }
      `);
  });

  test("exposes a compact boolean helper for menu and sidebar gates", () => {
    expect(
      canUseServerBackedDatabases({
        flavour: "myoxus-cloud",
        id: "workspace-1",
      }),
    ).toBe(true);
    expect(
      canUseServerBackedDatabases({ flavour: "local", id: "local-1" }),
    ).toBe(false);
  });
});
