/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { getWorkspaceServerDisplayName } from "./labels";

const repoRoot = process.cwd();
const labelsSourcePath =
  "client/libs/core/src/desktop/dialogs/setting/workspace-setting/preference/labels.tsx";

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("workspace preference server label", () => {
  test("uses the configured server name when it is instance-specific", () => {
    expect(
      getWorkspaceServerDisplayName({
        baseUrl: "https://workspace.example.test",
        fallback: "Self-hosted",
        serverName: "Acme Knowledge",
      }),
    ).toBe("Acme Knowledge");
  });

  test("normalizes configured server names and URLs before rendering them", () => {
    expect(
      getWorkspaceServerDisplayName({
        baseUrl: "  https://workspace.example.test  ",
        fallback: "Self-hosted",
        serverName: "  Acme Knowledge  ",
      }),
    ).toBe("Acme Knowledge");
  });

  test("falls back to the selected server URL for generic product names", () => {
    for (const serverName of [
      "Myoxus Cloud",
      "Myoxus Server",
      "Myoxus Standalone",
    ]) {
      expect(
        getWorkspaceServerDisplayName({
          baseUrl: "https://workspace.example.test",
          fallback: "Self-hosted",
          serverName,
        }),
      ).toBe("https://workspace.example.test");
    }
  });

  test("uses the translated fallback when neither server name nor URL is available", () => {
    expect(
      getWorkspaceServerDisplayName({
        baseUrl: null,
        fallback: "Self-hosted",
        serverName: null,
      }),
    ).toBe("Self-hosted");
  });

  test("does not render the workspace state chip from the static Myoxus Cloud translation", () => {
    const source = readRepoFile(labelsSourcePath);

    expect(source).toContain("WorkspaceServerService");
    expect(source).toContain("serverConfig?.serverName");
    expect(source).toContain("server?.baseUrl");
    expect(source).not.toContain(
      'value: t["com.myoxus.settings.workspace.state.myoxus-cloud"]()',
    );
  });
});
