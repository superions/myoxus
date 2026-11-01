// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const roots = ["client/libs/core/src", "client/web/workspaces/web/src"];
const allowedOwners = new Set([
  "client/libs/core/src/modules/server/services/user-preferences.spec.ts",
  "client/libs/core/src/modules/server/services/user-preferences.test-fixtures.ts",
  "client/libs/core/src/modules/server/services/user-preferences.ts",
  "client/libs/core/src/modules/server/services/workbench-tool-layout-ownership.spec.ts",
  "client/libs/core/src/modules/server/stores/user-preferences.ts",
  "client/libs/core/src/modules/database/test-harness.tsx",
  "client/libs/core/src/modules/workbench/view/tool-layout-binding.tsx",
]);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("Workbench tool-layout ownership", () => {
  test("keeps persistence behind the account-scoped preference service", () => {
    const offenders = roots.flatMap((root) =>
      sourceFiles(join(repoRoot, root)).flatMap((path) => {
        const repoPath = relative(repoRoot, path);
        if (allowedOwners.has(repoPath)) return [];
        const source = readFileSync(path, "utf8");
        return /workbenchToolLayouts/.test(source) ? [repoPath] : [];
      }),
    );

    expect(offenders).toEqual([]);
  });

  test("keeps raw cache and transport dependencies out of the service API", () => {
    const service = readFileSync(
      join(
        repoRoot,
        "client/libs/core/src/modules/server/services/user-preferences.ts",
      ),
      "utf8",
    );

    expect(service).not.toContain("GlobalState");
    expect(service).not.toContain("localStorage");
    expect(service).not.toContain("atom(");
    expect(service).not.toContain("gqlService");
  });

  test("keeps rail visibility transient and deletes obsolete width persistence", () => {
    const workbench = readFileSync(
      join(
        repoRoot,
        "client/libs/core/src/modules/workbench/entities/workbench.ts",
      ),
      "utf8",
    );
    const chat = readFileSync(
      join(
        repoRoot,
        "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/ai-chat/panel.tsx",
      ),
      "utf8",
    );

    expect(workbench).not.toContain("workbenchContextPanelOpen");
    expect(workbench).not.toContain("workbenchContextPanelWidth");
    expect(workbench).not.toContain("contextPanelWidth$");
    expect(chat).not.toContain("setContextPanelWidth");
    expect(chat).not.toContain("AI_PREVIEW_MIN_SIDEBAR_WIDTH");
  });
});
