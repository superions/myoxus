// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Layout } from "./layout";
import { useRightPanel } from "./panel/context";

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

function PanelConsumer() {
  const panel = useRightPanel();
  const navigate = useNavigate();
  return (
    <>
      <button
        onClick={() => {
          panel.setPanelContent(
            <input aria-label="Detail draft" defaultValue="Initial" />,
          );
          panel.openPanel();
        }}
      >
        Inspect
      </button>
      <button onClick={() => panel.setHasDirtyChanges(true)}>Mark dirty</button>
      <button onClick={() => navigate("/next")}>Next route</button>
      <output>
        {panel.isOpen ? "Open" : "Closed"} /{" "}
        {panel.hasDirtyChanges ? "Dirty" : "Clean"}
      </output>
    </>
  );
}

test("sidebar toggles preserve the open detail draft and route changes clear the controller", () => {
  render(
    <MyoxusUIProvider>
      <MemoryRouter initialEntries={["/queue"]}>
        <Layout>
          <PanelConsumer />
        </Layout>
      </MemoryRouter>
    </MyoxusUIProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Detail draft" }), {
    target: { value: "Unsaved" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Mark dirty" }));
  fireEvent.click(screen.getByTestId("shell-sidebar-toggle-expanded"));
  expect(screen.getByRole("navigation").textContent).toBe("Icons");
  expect(screen.getByRole("status").textContent).toBe("Open / Dirty");
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Detail draft" })
      .value,
  ).toBe("Unsaved");
  fireEvent.click(screen.getByTestId("shell-sidebar-toggle-collapsed"));
  expect(screen.getByRole("navigation").textContent).toBe(
    "Git synchronisation",
  );
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Detail draft" })
      .value,
  ).toBe("Unsaved");
  expect(screen.getByRole("status").textContent).toBe("Open / Dirty");
  fireEvent.click(screen.getByRole("button", { name: "Next route" }));
  expect(screen.queryByRole("textbox", { name: "Detail draft" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Closed / Clean");
});
