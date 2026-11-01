// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";

import { resolvePublicControlAvailability } from "./public-control-menu-items";

describe("public share-menu workspace boundary", () => {
  test("uses effective workspace availability while retaining revocation", () => {
    expect(
      resolvePublicControlAvailability({
        isRevalidating: false,
        workspaceLoading: false,
        workspaceError: null,
        publiclyAccessible: false,
        isShared: true,
      }),
    ).toEqual({
      workspaceStateUnavailable: false,
      publishDisabled: true,
      revokeDisabled: false,
      copyDisabled: true,
    });
  });
});
