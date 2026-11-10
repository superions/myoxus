// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { NotificationButton } from "./notification-button";

const mocks = vi.hoisted(() => ({
  count$: { value: 0 },
  openInbox: vi.fn(),
  workbench: {
    open: vi.fn(),
  },
}));

vi.mock("@myoxus/core/modules/app-sidebar/views", () => ({
  MenuItem: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@myoxus/core/modules/notification", () => ({
  NotificationCountService: class NotificationCountService {},
}));

vi.mock("@myoxus/core/modules/workbench", () => ({
  WorkbenchService: class WorkbenchService {},
}));

vi.mock("@myoxus/infra", () => ({
  useLiveData: () => mocks.count$.value,
  useService: () => mocks,
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.rootAppSidebar.notifications": () => "Notifications",
  }),
}));

vi.mock("@myoxus/track", () => ({
  track: {
    $: { sidebar: { notifications: { openInbox: mocks.openInbox } } },
  },
}));

vi.mock("../notification/list", () => ({
  NotificationList: ({ onOpenInbox }: { onOpenInbox?: () => void }) => (
    <button type="button" onClick={onOpenInbox}>
      Notification inbox
    </button>
  ),
}));

describe("NotificationButton", () => {
  afterEach(() => {
    cleanup();
    mocks.openInbox.mockClear();
    mocks.workbench.open.mockClear();
  });

  test("removes the trigger tooltip when the compact Menu opens", async () => {
    const user = userEvent.setup();
    render(
      <MyoxusUIProvider env="test">
        <NotificationButton compact />
      </MyoxusUIProvider>,
    );

    const trigger = screen.getByTestId("notification-button");
    expect(trigger.getAttribute("role")).toBe("button");
    expect(
      trigger
        .closest('[data-myoxus-ui-role="sidebar-notification-indicator"]')
        ?.getAttribute("role"),
    ).toBeNull();
    await user.hover(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Notifications",
    );

    await user.click(trigger);
    expect(await screen.findByText("Notification inbox")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(mocks.openInbox).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("Notification inbox"));
    expect(mocks.workbench.open).toHaveBeenCalledWith(
      "/inbox?read=unread&type=all",
      { at: "active" },
    );
  });
});
