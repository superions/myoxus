// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { canUseLocalWorkspaces } from "./local-workspace-capability";

describe("local workspace runtime capability", () => {
  test("rejects browser web runtime", () => {
    expect(
      canUseLocalWorkspaces({
        isAndroid: false,
        isElectron: false,
        isIOS: false,
      }),
    ).toBe(false);
  });

  test("keeps local workspaces enabled for Electron", () => {
    expect(
      canUseLocalWorkspaces({
        isElectron: true,
      }),
    ).toBe(true);
  });

  test("keeps local workspaces enabled for native mobile runtimes", () => {
    expect(
      canUseLocalWorkspaces({
        isAndroid: true,
      }),
    ).toBe(true);
    expect(
      canUseLocalWorkspaces({
        isIOS: true,
      }),
    ).toBe(true);
  });

  test("keeps the default path compatible with compile-time build flags", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/modules/workspace/local-workspace-capability.ts",
      ),
      "utf-8",
    );

    expect(source).toContain("BUILD_CONFIG.isElectron");
    expect(source).not.toContain("return BUILD_CONFIG;");
  });
});
