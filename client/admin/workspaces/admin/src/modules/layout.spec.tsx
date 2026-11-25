// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Layout } from "./layout";

vi.mock("@myoxus/i18n", async () => {
  const { createI18nMock } = await import("../__tests__/test-utils");
  return createI18nMock();
});
vi.mock("./nav/nav", () => ({
  Nav: ({ isCollapsed }: { isCollapsed: boolean }) => (
    <nav aria-label="Routes">
      {isCollapsed ? "Icons" : "Git synchronisation"}
    </nav>
  ),
}));

beforeEach(() => {
  clearBrandIdentityCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ appServerBranding: null })),
    ),
  );
});
afterEach(() => {
  cleanup();
  clearBrandIdentityCache();
  vi.unstubAllGlobals();
});

test("two-pane shell preserves main content across sidebar toggles without a global right detail pane", () => {
  render(
    <MyoxusUIProvider>
      <MemoryRouter initialEntries={["/queue"]}>
        <Layout>
          <input aria-label="Route draft" defaultValue="Initial" />
        </Layout>
      </MemoryRouter>
    </MyoxusUIProvider>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Route draft" }), {
    target: { value: "Unsaved" },
  });
  fireEvent.click(screen.getByTestId("shell-sidebar-toggle-expanded"));
  expect(screen.getByRole("navigation").textContent).toBe("Icons");
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Route draft" })
      .value,
  ).toBe("Unsaved");
  fireEvent.click(screen.getByTestId("shell-sidebar-toggle-collapsed"));
  expect(screen.getByRole("navigation").textContent).toBe(
    "Git synchronisation",
  );
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Route draft" })
      .value,
  ).toBe("Unsaved");
  expect(document.getElementById("admin-details")).toBeNull();
});
