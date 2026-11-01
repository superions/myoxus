// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepoFile(path: string) {
  return readFileSync(`${REPO_ROOT}${path}`, "utf8");
}

describe("web client local workspace exclusion contract", () => {
  test("keeps legacy local-first browser e2e material out of Browser Web gates", () => {
    const localE2eDir = `${REPO_ROOT}tests/client/webfrontend/local/e2e`;
    const remainingFiles = readdirSync(localE2eDir).filter((file) =>
      file.endsWith(".spec.ts"),
    );

    expect(
      remainingFiles.filter((file) => file.startsWith("local-first-")),
    ).toEqual([]);
    expect(remainingFiles).not.toContain("open-affine.spec.ts");

    for (const file of remainingFiles) {
      const source = readRepoFile(`tests/client/webfrontend/local/e2e/${file}`);
      expect(source, file).not.toContain("createLocalWorkspace");
      expect(source, file).not.toMatch(/meta\.flavour.*local/);
    }

    const runner = readRepoFile(
      "tests/client/webfrontend/local/scripts/run-local-e2e.sh",
    );
    expect(runner).toContain("MYOXUS_RUN_LEGACY_LOCAL_WEB_E2E");
    expect(runner).toContain(
      "Browser Web no longer creates or persists local workspaces",
    );
  });

  test("gates local workspace creation and listing behind the shared runtime capability", () => {
    const localProvider = readRepoFile(
      "client/libs/core/src/modules/workspace-engine/impls/local.ts",
    );

    expect(localProvider).toContain("canUseLocalWorkspaces()");
    expect(localProvider).toContain(
      "Local workspaces are not supported in this runtime",
    );
    expect(localProvider).toContain("subscriber.next([])");
  });

  test("removes local workspace choices from browser web UI while preserving cloud creation", () => {
    const createDialog = readRepoFile(
      "client/libs/core/src/desktop/dialogs/create-workspace/index.tsx",
    );
    const serverSelector = readRepoFile(
      "client/libs/core/src/desktop/dialogs/create-workspace/server-selector.tsx",
    );
    const workspaceSelector = readRepoFile(
      "client/libs/core/src/components/workspace-selector/user-with-workspace-list/index.tsx",
    );
    const workspaceList = readRepoFile(
      "client/libs/core/src/components/workspace-selector/user-with-workspace-list/workspace-list/index.tsx",
    );

    expect(createDialog).toContain(
      'serverId === "local" && !canUseLocalWorkspaces()',
    );
    expect(serverSelector).toContain("buildWorkspaceTargetOptions");
    expect(serverSelector).toContain("includeLocal: canUseLocalWorkspaces()");
    expect(serverSelector).toContain("<FormSelect");
    expect(serverSelector).not.toContain("<MyoxusSelect");
    expect(serverSelector).not.toContain("<Menu");
    expect(workspaceSelector).toMatch(
      /canUseLocalWorkspaces\(\)\s*&&\s*\(\s*BUILD_CONFIG\.isNative/,
    );
    expect(workspaceList).toContain(
      "const localWorkspacesEnabled = canUseLocalWorkspaces();",
    );
    expect(workspaceList).toContain("localWorkspacesEnabled ? (");
  });

  test("does not ship the retired server-to-local metadata migration", () => {
    for (const path of [
      "client/libs/core/src/modules/server/services/doc-created-by-updated-by-sync.ts",
      "client/libs/core/src/modules/server/stores/doc-created-by-updated-by-sync.ts",
      "client/libs/core/src/desktop/pages/workspace/all-page/migration-data.tsx",
    ]) {
      expect(existsSync(`${REPO_ROOT}${path}`), path).toBe(false);
    }
    expect(
      readRepoFile(
        "client/libs/core/src/desktop/pages/workspace/all-page/all-page.tsx",
      ),
    ).not.toContain("MigrationAllDocsDataNotification");
  });

  test("hides native local-workspace settings actions in browser web", () => {
    const preferenceSettings = readRepoFile(
      "client/libs/core/src/desktop/dialogs/setting/workspace-setting/preference/index.tsx",
    );
    const membersSettings = readRepoFile(
      "client/libs/core/src/desktop/dialogs/setting/workspace-setting/members/index.tsx",
    );
    const storageSettings = readRepoFile(
      "client/libs/core/src/desktop/dialogs/setting/workspace-setting/storage/index.tsx",
    );

    expect(preferenceSettings).toContain(
      'workspace.flavour === "local" && canUseLocalWorkspaces()',
    );
    expect(membersSettings).toContain(
      "showEnableCloud={canUseLocalWorkspaces()}",
    );
    expect(storageSettings).toContain("canUseLocalWorkspaces() ? (");
    expect(preferenceSettings).toContain("{canUseLocalWorkspaces() && (");
    expect(preferenceSettings).toContain('data-testid="reset-sync-status"');
  });

  test("keeps native local workspace skip affordances out of browser web sign-in", () => {
    const signInPanel = readRepoFile(
      "client/libs/core/src/components/sign-in/sign-in.tsx",
    );

    expect(signInPanel).toContain("canUseLocalWorkspaces()");
    expect(signInPanel).toContain(
      "const showNativeLocalEntry = canUseLocalWorkspaces();",
    );
    expect(signInPanel).toContain("{showNativeLocalEntry && (");
    expect(signInPanel).toContain("LocalWorkspaceIcon");
  });

  test("keeps cloud workspace status labels descriptive instead of action-like", () => {
    const labelsPanel = readRepoFile(
      "client/libs/core/src/desktop/dialogs/setting/workspace-setting/preference/labels.tsx",
    );
    const resourceFiles = readdirSync(
      `${REPO_ROOT}client/libs/i18n/src/resources`,
    )
      .filter((file) => file.endsWith(".json"))
      .map(
        (file) =>
          [
            file,
            readRepoFile(`client/libs/i18n/src/resources/${file}`),
          ] as const,
      );

    expect(labelsPanel).not.toContain("sync-myoxus-cloud");
    expect(labelsPanel).toContain("getWorkspaceServerDisplayName");
    expect(labelsPanel).toContain("serverDisplayName");
    for (const [file, resource] of resourceFiles) {
      expect(resource, file).not.toContain(
        "com.myoxus.settings.workspace.state.sync-myoxus-cloud",
      );
    }
  });

  test("does not mount the legacy workspace selector in the loading sidebar", () => {
    const appSidebarFallback = readRepoFile(
      "client/libs/core/src/modules/app-sidebar/views/index.tsx",
    );

    expect(appSidebarFallback).not.toContain("WorkspaceNavigator");
    expect(appSidebarFallback).not.toContain("canUseLocalWorkspaces");
    expect(appSidebarFallback).toContain("<ShellBrandWordmark");
    expect(appSidebarFallback).toContain('surface="navigation"');
  });
});
