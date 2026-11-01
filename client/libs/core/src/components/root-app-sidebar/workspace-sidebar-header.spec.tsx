// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceSidebarHeader } from "./workspace-sidebar-header";

const mocks = vi.hoisted(() => ({
  open$: { value: true },
  toggleSidebar: vi.fn(),
  trackToggle: vi.fn(),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: (source: { value: unknown }) => source.value,
    useService: () => ({
      sidebar: {
        open$: mocks.open$,
        toggleSidebar: mocks.toggleSidebar,
      },
    }),
  };
});

vi.mock("@myoxus/i18n", async (original) => ({
  ...(await original<typeof import("@myoxus/i18n")>()),
  useI18n: () => ({
    "Quick search": () => "Quick search",
    "com.myoxus.sidebarSwitch.collapse": () => "Collapse sidebar",
    "com.myoxus.sidebarSwitch.expand": () => "Expand sidebar",
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/ui-facade")>();
  return {
    ...actual,
    ShellBrandWordmark: () => <span>Myoxus</span>,
  };
});

vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      navigationPanel: {
        $: { toggle: mocks.trackToggle },
      },
    },
  },
}));

describe("WorkspaceSidebarHeader", () => {
  afterEach(() => {
    cleanup();
    mocks.toggleSidebar.mockClear();
    mocks.trackToggle.mockClear();
    mocks.open$.value = true;
  });

  test("keeps the app sidebar collapse action beside the header quick actions", async () => {
    const user = userEvent.setup();
    render(
      <MyoxusUIProvider>
        <WorkspaceSidebarHeader onSearch={vi.fn()} showNotifications={false} />
      </MyoxusUIProvider>,
    );

    const header = document.querySelector(
      '[data-myoxus-ui-role="workspace-sidebar-header"]',
    );
    expect(header).not.toBeNull();

    const search = screen.getByTestId("slider-bar-quick-search-button");
    const collapse = screen.getByTestId("app-sidebar-collapse-button");
    const buttons = within(header as HTMLElement).getAllByRole("button");
    expect(buttons.indexOf(search)).toBeLessThan(buttons.indexOf(collapse));

    await user.click(collapse);

    expect(mocks.trackToggle).toHaveBeenCalledWith({ type: "collapse" });
    expect(mocks.toggleSidebar).toHaveBeenCalledTimes(1);
  });

  test("keeps product header ownership out of the app sidebar state shell", () => {
    const coreRoot = join(process.cwd(), "client/libs/core/src");
    const composition = readFileSync(
      join(coreRoot, "components/root-app-sidebar/index.tsx"),
      "utf8",
    );
    const appSidebar = readFileSync(
      join(coreRoot, "modules/app-sidebar/views/index.tsx"),
      "utf8",
    );
    const toggle = readFileSync(
      join(coreRoot, "modules/app-sidebar/views/app-sidebar-toggle.tsx"),
      "utf8",
    );

    expect(composition).toContain("<WorkspaceSidebarHeader");
    expect(composition).not.toContain("WorkspaceNavigationHeader");
    expect(appSidebar).not.toContain('from "./sidebar-header"');
    expect(appSidebar).not.toContain("?? <SidebarHeader />");
    expect(toggle).toContain("export const AppSidebarToggle");
    expect(toggle).not.toContain("show:");
  });
});
