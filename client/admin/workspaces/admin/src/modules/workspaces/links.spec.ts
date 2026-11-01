import { describe, expect, test } from "vitest";

import {
  buildGitSyncSettingsPath,
  buildGitSyncSettingsUrl,
  getWorkspaceBasePath,
} from "./links";

describe("getWorkspaceBasePath", () => {
  test("falls back to normalized subPath for non-adminfrontend paths", () => {
    expect(getWorkspaceBasePath("/myoxus")).toBe("/myoxus");
    expect(getWorkspaceBasePath("myoxus")).toBe("/myoxus");
  });
});

describe("buildGitSyncSettingsPath", () => {
  test("builds integrations settings route for root deployment", () => {
    expect(buildGitSyncSettingsPath("ws-1", "/adminfrontend")).toBe(
      "/workspace/ws-1/settings?tab=workspace%3Aintegrations",
    );
  });

  test("builds integrations settings route for prefixed deployment", () => {
    expect(buildGitSyncSettingsPath("ws-1", "/myoxus/adminfrontend")).toBe(
      "/myoxus/workspace/ws-1/settings?tab=workspace%3Aintegrations",
    );
  });
});

describe("buildGitSyncSettingsUrl", () => {
  test("builds absolute URL with current origin", () => {
    expect(
      buildGitSyncSettingsUrl(
        "ws-1",
        "/myoxus/adminfrontend",
        "https://example.test",
      ),
    ).toBe(
      "https://example.test/myoxus/workspace/ws-1/settings?tab=workspace%3Aintegrations",
    );
  });
});
