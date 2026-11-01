// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  isWorkspaceTagColorRole,
  WORKSPACE_TAG_COLOR_ROLES,
  workspaceTagColorRoleOrGrey,
} from "./color-role";

describe("workspace tag color roles", () => {
  test("keeps one unique nine-role runtime contract", () => {
    expect(new Set(WORKSPACE_TAG_COLOR_ROLES).size).toBe(9);
    for (const role of WORKSPACE_TAG_COLOR_ROLES) {
      expect(isWorkspaceTagColorRole(role)).toBe(true);
    }
    expect(isWorkspaceTagColorRole("tag.unknown")).toBe(false);
  });

  test("uses grey only for defensive non-authoritative projections", () => {
    expect(workspaceTagColorRoleOrGrey("tag.teal")).toBe("tag.teal");
    expect(workspaceTagColorRoleOrGrey("tag.unknown")).toBe("tag.grey");
    expect(workspaceTagColorRoleOrGrey(null)).toBe("tag.grey");
  });
});
