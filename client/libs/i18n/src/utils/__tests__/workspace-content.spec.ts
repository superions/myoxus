// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";

import { workspaceContentFailureKey } from "../workspace-content";

describe("workspace transfer failure causes", () => {
  test("retains an exact authored reason without exposing arbitrary exceptions", () => {
    expect(
      workspaceContentFailureKey(
        "workspace content Move revision manifest is invalid",
        "XWS_UNEXPECTED_VALIDATION",
      ),
    ).toBe("com.myoxus.workspace-content-operation.error.move-manifest");
    expect(
      workspaceContentFailureKey(
        "credential-adjacent dependency exception",
        "unknown-code",
      ),
    ).toBeUndefined();
  });
});
