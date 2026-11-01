// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  CountIndicator,
  Menu,
  MenuItem,
  MobileHomeHeaderActions,
  MobileHomeHeaderContent,
  MobileHomeHeaderFloatingBar,
  MobileHomeHeaderFloatingWorkspaceSlot,
  MobileHomeHeaderRoot,
  MobileHomeHeaderSpacer,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("MobileHomeHeader facade", () => {
  test("owns dense floating header slots and notification indicator chrome", () => {
    render(
      <MyoxusUIProvider>
        <MobileHomeHeaderRoot data-testid="flow">
          <MobileHomeHeaderSpacer data-testid="spacer" />
          <MobileHomeHeaderContent>Search</MobileHomeHeaderContent>
        </MobileHomeHeaderRoot>
        <MobileHomeHeaderRoot fixed dense data-testid="fixed">
          <MobileHomeHeaderFloatingBar>
            <MobileHomeHeaderFloatingWorkspaceSlot dense>
              Workspace
            </MobileHomeHeaderFloatingWorkspaceSlot>
            <MobileHomeHeaderActions>
              <CountIndicator count={124} data-testid="indicator">
                <button type="button">Notifications</button>
              </CountIndicator>
            </MobileHomeHeaderActions>
          </MobileHomeHeaderFloatingBar>
        </MobileHomeHeaderRoot>
      </MyoxusUIProvider>,
    );

    const flow = screen.getByTestId("flow");
    expect(flow.dataset.myoxusUiRole).toBe("mobile-home-header");
    expect(flow.style.position).toBe("");
    expect(screen.getByTestId("spacer").dataset.myoxusUiRole).toBe(
      "mobile-home-header-spacer",
    );

    const fixed = screen.getByTestId("fixed");
    expect(fixed.style.position).toBe("fixed");
    expect(fixed.dataset.dense).toBe("true");
    expect(screen.getByText("Workspace").dataset.visible).toBe("true");
    expect(screen.getByTestId("indicator").dataset.myoxusUiRole).toBe(
      "count-indicator",
    );
    expect(screen.getByText("99+")).toBeDefined();
  });

  test("decorates a Menu trigger without creating a second button", async () => {
    render(
      <MyoxusUIProvider>
        <CountIndicator count={3}>
          <Menu items={<MenuItem data-testid="notifications">Unread</MenuItem>}>
            <button type="button">Notifications</button>
          </Menu>
        </CountIndicator>
      </MyoxusUIProvider>,
    );

    const triggers = screen.getAllByRole("button", { name: "Notifications" });
    expect(triggers).toHaveLength(1);
    fireEvent.click(triggers[0]);

    expect(await screen.findByTestId("notifications")).toBeDefined();
  });
});
