// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  createAppViewId,
  createRuntimeId,
  createWorkspaceImportId,
} from "../../src/shared/ids";

describe("Electron ESM runtime dependencies", () => {
  test("preserves unique Nanoid identifiers and their consumer lengths", () => {
    const runtimeIds = Array.from({ length: 1_000 }, createRuntimeId);
    const appViewIds = Array.from({ length: 1_000 }, createAppViewId);
    const workspaceIds = Array.from({ length: 1_000 }, createWorkspaceImportId);

    expect(new Set(runtimeIds).size).toBe(runtimeIds.length);
    expect(new Set(appViewIds).size).toBe(appViewIds.length);
    expect(new Set(workspaceIds).size).toBe(workspaceIds.length);
    expect(runtimeIds.every((id) => id.length === 21)).toBe(true);
    expect(appViewIds.every((id) => /^app-[\w-]{21}$/.test(id))).toBe(true);
    expect(workspaceIds.every((id) => id.length === 10)).toBe(true);
  });
});
