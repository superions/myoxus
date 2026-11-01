// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PlusIcon, RightSidebarIcon, SidebarIcon } from "@myoxus/icons/react";

import {
  AppTabStripActionButton,
  AppTabStripCloseButton,
  AppTabStripCloseSlot,
  AppTabStripDivider,
  AppTabStripDropIndicator,
  AppTabStripLeadingSlot,
  AppTabStripList,
  AppTabStripRoot,
  AppTabStripSpacer,
  AppTabStripTab,
  AppTabStripTabSlot,
  AppTabStripViewButton,
  AppTabStripViewIcon,
  AppTabStripViewLabel,
  AppTabStripWindowsControlsPlaceholder,
  AppWindowControlButton,
  AppWindowControlsRoot,
  ShellSidebarToggle,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("AppTabStrip facade primitives", () => {
  test("renders native-app tab chrome through semantic facade roles", () => {
    const close = vi.fn();
    const add = vi.fn();

    render(
      <MyoxusUIProvider>
        <AppTabStripRoot data-testid="root" mode="app" windows>
          <AppTabStripLeadingSlot
            data-testid="leading"
            expandedInlineSize={240}
            open
            resizing
            trafficLightReserve="macos"
          >
            Leading
          </AppTabStripLeadingSlot>
          <AppTabStripList data-testid="list">
            <AppTabStripTabSlot>
              <AppTabStripTab active data-testid="tab" viewCount={3}>
                <AppTabStripViewButton active>
                  <AppTabStripViewIcon>i</AppTabStripViewIcon>
                  <AppTabStripViewLabel>Document title</AppTabStripViewLabel>
                </AppTabStripViewButton>
                <AppTabStripDivider orientation="split-view" />
                <AppTabStripCloseSlot>
                  <AppTabStripCloseButton aria-label="Close" onClick={close}>
                    x
                  </AppTabStripCloseButton>
                </AppTabStripCloseSlot>
              </AppTabStripTab>
              <AppTabStripDropIndicator edge="left" data-testid="drop" />
            </AppTabStripTabSlot>
          </AppTabStripList>
          <AppTabStripSpacer draggedOver>
            <AppTabStripActionButton
              aria-label="New tab"
              size="small"
              icon={<PlusIcon />}
              onClick={add}
            />
          </AppTabStripSpacer>
          <AppTabStripActionButton aria-label="Right sidebar">
            <RightSidebarIcon />
          </AppTabStripActionButton>
          <AppTabStripWindowsControlsPlaceholder data-testid="windows" />
        </AppTabStripRoot>
        <ShellSidebarToggle aria-label="Left sidebar">
          <SidebarIcon />
        </ShellSidebarToggle>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("root").dataset.myoxusUiRole).toBe(
      "app-tab-strip",
    );
    expect(screen.getByTestId("leading").dataset.open).toBe("true");
    expect(screen.getByTestId("leading").getAttribute("style")).toContain(
      "--myoxus-app-tab-strip-expanded-inline-size: 240px",
    );
    expect(screen.getByTestId("leading").getAttribute("style")).toContain(
      "--myoxus-app-tab-strip-traffic-light-offset: 70px",
    );
    expect(screen.getByTestId("tab").dataset.active).toBe("true");
    const tabSlotStyle = screen
      .getByTestId("tab")
      .parentElement?.getAttribute("style");
    expect(tabSlotStyle).toContain("flex-grow: 0");
    expect(tabSlotStyle).toContain("flex-shrink: 0");
    expect(screen.getByTestId("list").className).toContain(
      "mantine-ScrollArea-root",
    );
    expect(screen.getByTestId("list").style.flexGrow).toBe("0");
    expect(screen.getByTestId("list").style.flexShrink).toBe("1");
    const listContent = screen
      .getByTestId("list")
      .querySelector<HTMLElement>(".myoxus-app-tab-strip__list-content");
    expect(listContent).not.toBeNull();
    expect(screen.getByTestId("tab").getAttribute("style")).toContain(
      "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
    );
    expect(screen.getByTestId("tab").getAttribute("style")).not.toMatch(
      /(?:52|64|200)px/,
    );
    expect(screen.getByTestId("drop").dataset.edge).toBe("left");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const addTabButton = screen.getByRole("button", { name: "New tab" });
    const leftSidebarButton = screen.getByRole("button", {
      name: "Left sidebar",
    });
    const rightSidebarButton = screen.getByRole("button", {
      name: "Right sidebar",
    });
    expect(rightSidebarButton.getAttribute("style")).toBe(
      leftSidebarButton.getAttribute("style"),
    );
    expect(rightSidebarButton.querySelector("svg")?.getAttribute("width")).toBe(
      leftSidebarButton.querySelector("svg")?.getAttribute("width"),
    );
    expect(rightSidebarButton.querySelector("svg")?.getAttribute("style")).toBe(
      leftSidebarButton.querySelector("svg")?.getAttribute("style"),
    );
    expect(addTabButton.querySelector("svg")?.style.width).toBe(
      "var(--mantine-spacing-lg)",
    );
    fireEvent.click(addTabButton);
    expect(close).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  test("renders Windows title-bar controls through facade roles", () => {
    const minimize = vi.fn();
    const maximize = vi.fn();
    const close = vi.fn();

    render(
      <MyoxusUIProvider>
        <AppWindowControlsRoot data-testid="window-controls">
          <AppWindowControlButton
            aria-label="Minimize window"
            control="minimize"
            onClick={minimize}
          >
            -
          </AppWindowControlButton>
          <AppWindowControlButton
            aria-label="Maximize window"
            control="maximize"
            onClick={maximize}
          >
            []
          </AppWindowControlButton>
          <AppWindowControlButton
            aria-label="Close window"
            control="close"
            onClick={close}
          >
            x
          </AppWindowControlButton>
        </AppWindowControlsRoot>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("window-controls").dataset.myoxusUiRole).toBe(
      "app-window-controls",
    );
    expect(
      screen.getByRole("button", { name: "Minimize window" }).className,
    ).toContain("myoxus-app-window-controls__button");
    expect(
      screen
        .getByRole("button", { name: "Close window" })
        .getAttribute("data-window-control"),
    ).toBe("close");

    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(maximize).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
