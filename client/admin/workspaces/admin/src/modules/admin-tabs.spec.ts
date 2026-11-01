// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useUrlSyncedAdminTab } from "./admin-tabs";

const TABS = ["overview", "colors", "branding"] as const;

describe("useUrlSyncedAdminTab", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/adminfrontend/design");
  });

  test("reads a valid tab from the URL and drops invalid values", () => {
    window.history.replaceState({}, "", "/adminfrontend/design?tab=colors");
    const valid = renderHook(() => useUrlSyncedAdminTab(TABS, "overview"));
    expect(valid.result.current[0]).toBe("colors");
    valid.unmount();

    window.history.replaceState({}, "", "/adminfrontend/design?tab=unknown");
    const invalid = renderHook(() => useUrlSyncedAdminTab(TABS, "overview"));
    expect(invalid.result.current[0]).toBe("overview");
  });

  test("writes non-default tabs to the URL and removes the default tab", () => {
    const { result } = renderHook(() => useUrlSyncedAdminTab(TABS, "overview"));

    act(() => result.current[1]("branding"));
    expect(result.current[0]).toBe("branding");
    expect(window.location.search).toBe("?tab=branding");

    act(() => result.current[1]("overview"));
    expect(result.current[0]).toBe("overview");
    expect(window.location.search).toBe("");
  });
});
