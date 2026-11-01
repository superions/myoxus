// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  WorkbenchContextPanelSurface,
  WorkbenchRouteSurface,
} from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalMatchMedia = window.matchMedia;

function setCompactViewport(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches: compact && query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  });
}

function CompactPanelHarness() {
  const [opened, setOpened] = useState(true);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button">
        Context trigger
      </button>
      <WorkbenchContextPanelSurface
        closeButtonLabel="Close context tools"
        drawerTitle="Context tools"
        opened={opened}
        onOpenChange={setOpened}
        returnFocusRef={triggerRef}
      >
        Context
      </WorkbenchContextPanelSurface>
    </>
  );
}

describe("Workbench surface scroll and context contract", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  test("owns one outer ScrollArea and no rail DOM while context is closed", () => {
    setCompactViewport(false);
    render(
      <MyoxusUIProvider>
        <WorkbenchRouteSurface
          context={
            <WorkbenchContextPanelSurface
              closeButtonLabel="Close"
              drawerTitle="Context tools"
              opened={false}
              onOpenChange={() => undefined}
            >
              Context
            </WorkbenchContextPanelSurface>
          }
          contextVisible={false}
        >
          <main>Main</main>
        </WorkbenchRouteSurface>
      </MyoxusUIProvider>,
    );

    expect(document.querySelectorAll(".mantine-ScrollArea-root")).toHaveLength(
      1,
    );
    expect(screen.getByText("Main")).not.toBeNull();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="workbench-context-panel-shell"]',
      ),
    ).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("renders an intrinsic desktop rail inside the same Grid", () => {
    setCompactViewport(false);
    render(
      <MyoxusUIProvider>
        <WorkbenchRouteSurface
          context={
            <WorkbenchContextPanelSurface
              closeButtonLabel="Close"
              drawerTitle="Context tools"
              opened
              onOpenChange={() => undefined}
            >
              Context
            </WorkbenchContextPanelSurface>
          }
          contextVisible
        >
          <main>Main</main>
        </WorkbenchRouteSurface>
      </MyoxusUIProvider>,
    );

    const rail = document.querySelector(
      '[data-myoxus-ui-role="workbench-context-panel-rail"]',
    );
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute("style")).toContain("position: sticky");
    expect(rail?.getAttribute("style")).not.toContain("height: 100%");
    expect(document.querySelectorAll(".mantine-ScrollArea-root")).toHaveLength(
      2,
    );
    const toolScrollArea = document.querySelector(
      '[data-myoxus-ui-role="workbench-context-panel-surface"]',
    );
    expect(toolScrollArea?.getAttribute("style")).toContain(
      "max-height: calc(100cqh - var(--mantine-spacing-xs) * 2)",
    );
    expect(
      toolScrollArea?.querySelector(
        '[data-myoxus-ui-role="workbench-tool-scroll-content"]',
      ),
    ).not.toBeNull();
  });

  test("uses a titled compact Drawer and focuses its close control", () => {
    setCompactViewport(true);
    render(
      <MyoxusUIProvider>
        <CompactPanelHarness />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: "Context tools" }),
    ).not.toBeNull();
    const close = screen.getByRole("button", { name: "Close context tools" });
    expect(close.getAttribute("data-autofocus")).toBe("true");
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="workbench-context-panel-shell"]',
      ),
    ).toBeNull();

    fireEvent.click(close);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Context trigger" }),
    );
  });
});
