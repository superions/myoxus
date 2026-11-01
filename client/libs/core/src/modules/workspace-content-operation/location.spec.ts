// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  clearWorkspaceContentOperationFromLocation,
  projectWorkspaceContentOperationToLocation,
  workspaceContentOperationFromLocation,
} from "./location";

const OPERATION_ID = "018f65a7-3c2b-7d11-8a22-123456789abc";

describe("workspace content operation route handle", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  test("restores only a valid durable operation identity after reload", () => {
    window.history.replaceState(null, "", "/workspace/source/home?view=all");

    projectWorkspaceContentOperationToLocation(OPERATION_ID);

    expect(workspaceContentOperationFromLocation()).toBe(OPERATION_ID);
    expect(new URL(window.location.href).searchParams.get("view")).toBe("all");

    window.history.replaceState(
      null,
      "",
      "/workspace/source/home?workspaceContentOperation=not-an-operation",
    );
    expect(workspaceContentOperationFromLocation()).toBeNull();
  });

  test("clears only the matching terminal operation", () => {
    projectWorkspaceContentOperationToLocation(OPERATION_ID);

    clearWorkspaceContentOperationFromLocation(
      "018f65a7-3c2b-7d11-8a22-abcdefabcdef",
    );
    expect(workspaceContentOperationFromLocation()).toBe(OPERATION_ID);

    clearWorkspaceContentOperationFromLocation(OPERATION_ID);
    expect(workspaceContentOperationFromLocation()).toBeNull();
  });
});
