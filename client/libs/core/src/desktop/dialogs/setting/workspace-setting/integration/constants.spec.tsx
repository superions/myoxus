/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/core/modules/integration", () => ({
  IntegrationTypeIcon: () => <svg data-testid="integration-type-icon" />,
}));

vi.mock("./git-sync/setting-panel", () => ({
  GitSyncSettingPanel: () => null,
}));

vi.mock("./mcp-server/setting-panel", () => ({
  McpServerSettingPanel: () => null,
}));

vi.mock("./readwise/setting-panel", () => ({
  ReadwiseSettingPanel: () => null,
}));

vi.mock("@myoxus/icons/react", () => ({
  GithubIcon: () => <span data-testid="github-icon" />,
  McpIcon: () => <span data-testid="mcp-icon" />,
}));

import { getAllowedIntegrationList } from "./constants";

describe("integration constants branding", () => {
  test("filters cloud-only integrations for local workspaces", () => {
    const localItems = getAllowedIntegrationList(false);
    const localIds = localItems.map((item) => item.id);

    expect(localIds).toEqual(["readwise", "git-sync"]);
    expect(localIds).not.toContain("calendar");
    expect(localIds).not.toContain("mcp-server");
  });

  test("keeps remaining cloud-only integrations for cloud workspaces", () => {
    const cloudItems = getAllowedIntegrationList(true);
    const cloudIds = cloudItems.map((item) => item.id);

    expect(cloudIds).toContain("mcp-server");
    expect(cloudIds).toEqual(["readwise", "git-sync", "mcp-server"]);
    expect(cloudIds).not.toContain("calendar");
  });
});
