// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  NotificationPanelDeleteAction,
  NotificationPanelEmpty,
  NotificationPanelEntity,
  NotificationPanelEntityIcon,
  NotificationPanelHeader,
  NotificationPanelHeaderTitle,
  NotificationPanelItem,
  NotificationPanelItemDate,
  NotificationPanelItemMain,
  NotificationPanelItemMessage,
  NotificationPanelItemSkeleton,
  NotificationPanelList,
  NotificationPanelLoadMoreIndicator,
  NotificationPanelRoot,
  NotificationPanelScrollRoot,
  NotificationPanelViewport,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("NotificationPanel facade", () => {
  test("renders panel chrome, empty state and notification row semantics", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();

    render(
      <MyoxusUIProvider>
        <NotificationPanelRoot mobile>
          <NotificationPanelHeader>
            <NotificationPanelHeaderTitle>
              Notifications
            </NotificationPanelHeaderTitle>
          </NotificationPanelHeader>
          <NotificationPanelScrollRoot>
            <NotificationPanelViewport>
              <NotificationPanelList aria-label="Notifications">
                <li>
                  <NotificationPanelItem onClick={onOpen}>
                    <NotificationPanelItemMain>
                      <NotificationPanelItemMessage>
                        <NotificationPanelEntity inactive>
                          <NotificationPanelEntityIcon>
                            @
                          </NotificationPanelEntityIcon>
                          Ada
                        </NotificationPanelEntity>{" "}
                        mentioned you
                      </NotificationPanelItemMessage>
                      <NotificationPanelItemDate>now</NotificationPanelItemDate>
                    </NotificationPanelItemMain>
                    <NotificationPanelDeleteAction
                      aria-label="Dismiss notification"
                      onClick={onDismiss}
                    >
                      x
                    </NotificationPanelDeleteAction>
                  </NotificationPanelItem>
                </li>
              </NotificationPanelList>
              <NotificationPanelLoadMoreIndicator>
                Loading more
              </NotificationPanelLoadMoreIndicator>
              <NotificationPanelItemSkeleton />
              <NotificationPanelEmpty
                title="No notifications"
                description="Done"
              />
            </NotificationPanelViewport>
          </NotificationPanelScrollRoot>
        </NotificationPanelRoot>
      </MyoxusUIProvider>,
    );

    const panel = screen
      .getByText("Notifications")
      .closest("[data-myoxus-ui-role='notification-panel']");
    expect(panel?.getAttribute("data-mobile")).toBe("true");
    expect(screen.getByRole("list", { name: "Notifications" })).not.toBeNull();

    const row = screen.getByRole("button", { name: /Ada mentioned you/ });
    expect(row.dataset.myoxusUiRole).toBe("notification-panel-item");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);

    const entity = screen
      .getByText("Ada")
      .closest("[data-myoxus-ui-role='notification-panel-entity']");
    expect(entity?.getAttribute("data-inactive")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No notifications")).not.toBeNull();
    expect(screen.getByText("Loading more")).not.toBeNull();
  });
});
