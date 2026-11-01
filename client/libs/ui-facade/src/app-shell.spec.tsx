// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AppContainerDesktopMain,
  AppContainerDesktopTabsHeader,
  AppContainerLayout,
  AppContainerRoot,
  AppMainRegion,
  Splitter,
  ShellDesktopViewportSlot,
  ShellMobileViewportSlot,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("app shell facade primitives", () => {
  test("render application shell roles and state attributes", () => {
    render(
      <MyoxusUIProvider>
        <AppContainerRoot noisyBackground translucent>
          <AppContainerLayout variant="desktop">
            <AppContainerDesktopTabsHeader>Tabs</AppContainerDesktopTabsHeader>
            <AppContainerDesktopMain>
              <AppMainRegion
                clientBorder
                isDesktop
                sideBarOpen
                data-testid="main"
              >
                Main
              </AppMainRegion>
            </AppContainerDesktopMain>
          </AppContainerLayout>
        </AppContainerRoot>
      </MyoxusUIProvider>,
    );

    const tabsHeader = screen
      .getByText("Tabs")
      .closest("[data-myoxus-ui-role]");
    expect(tabsHeader?.getAttribute("data-myoxus-ui-role")).toBe(
      "app-container-desktop-tabs-header",
    );

    const root = tabsHeader?.closest(
      '[data-myoxus-ui-role="app-container-root"]',
    );
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-noise-background")).toBe("true");
    expect(root?.getAttribute("data-translucent")).toBe("true");

    const layout = tabsHeader?.closest(
      '[data-myoxus-ui-role="app-container-layout"]',
    );
    expect(layout?.getAttribute("data-variant")).toBe("desktop");

    const desktopMain = screen
      .getByText("Main")
      .closest('[data-myoxus-ui-role="app-container-desktop-main"]');
    expect(desktopMain).not.toBeNull();

    const main = screen.getByTestId("main");
    expect(main.getAttribute("data-myoxus-ui-role")).toBe("app-main");
    expect(main.getAttribute("data-client-border")).toBe("false");
    expect(main.getAttribute("data-is-desktop")).toBe("true");
    expect(main.getAttribute("data-side-bar-open")).toBe("true");
    expect(main.style.overflow).toBe("clip");
  });

  test("renders shell viewport slots through the facade breakpoint boundary", () => {
    installMatchMedia(true);

    const { rerender } = render(
      <MyoxusUIProvider>
        <ShellMobileViewportSlot>
          <span>Mobile slot</span>
        </ShellMobileViewportSlot>
        <ShellDesktopViewportSlot>
          <span>Desktop slot</span>
        </ShellDesktopViewportSlot>
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Mobile slot")).not.toBeNull();
    expect(screen.queryByText("Desktop slot")).toBeNull();

    installMatchMedia(false);
    rerender(
      <MyoxusUIProvider>
        <ShellMobileViewportSlot>
          <span>Mobile slot</span>
        </ShellMobileViewportSlot>
        <ShellDesktopViewportSlot>
          <span>Desktop slot</span>
        </ShellDesktopViewportSlot>
      </MyoxusUIProvider>,
    );

    expect(screen.queryByText("Mobile slot")).toBeNull();
    expect(screen.getByText("Desktop slot")).not.toBeNull();
  });

  test("resizes shell panes by keyboard without unmounting their content", () => {
    const onSizeChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <Splitter onSizeChange={onSizeChange}>
          <Splitter.Pane defaultSize={50} min={20}>
            Main
          </Splitter.Pane>
          <Splitter.Pane defaultSize={50} min={20}>
            Details
          </Splitter.Pane>
        </Splitter>
      </MyoxusUIProvider>,
    );
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(onSizeChange).toHaveBeenLastCalledWith([51, 49]);
    expect(screen.getByText("Main")).not.toBeNull();
    expect(screen.getByText("Details")).not.toBeNull();
  });
});
