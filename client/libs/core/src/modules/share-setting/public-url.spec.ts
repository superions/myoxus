// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { canonicalPublicWorkspaceUrl } from "./public-url";

describe("canonicalPublicWorkspaceUrl", () => {
  test("uses the configured server origin and canonical workspace route", () => {
    expect(
      canonicalPublicWorkspaceUrl({
        baseUrl: "https://workspace.example/base/path",
        workspaceId: "workspace-id",
      }),
    ).toBe("https://workspace.example/public/workspace-id");
  });
});
