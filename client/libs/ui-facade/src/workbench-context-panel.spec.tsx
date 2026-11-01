// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MyoxusUIProvider } from "./provider";
import { WorkbenchContextPanelLayout } from "./workbench-context-panel";

const originalMatchMedia = window.matchMedia;

describe("Workbench Context Panel surface", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  test("keeps the desktop rail headerless and owns compact Drawer focus", async () => {
    function ContextHarness() {
      const [opened, setOpened] = useState(true);
      const returnFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <WorkbenchContextPanelLayout
          closeButtonLabel="Close"
          context={<div>Context content</div>}
          contextOpened={opened}
          contextTitle="Context tools"
          onContextOpenChange={setOpened}
          returnFocusRef={returnFocusRef}
        >
          <button ref={returnFocusRef}>Selected object</button>
        </WorkbenchContextPanelLayout>
      );
    }

    render(
      <MyoxusUIProvider>
        <ContextHarness />
      </MyoxusUIProvider>,
    );

    const content = screen.getByText("Context content");
    const surface = content.closest(
      '[data-myoxus-ui-role="workbench-context-panel-surface"]',
    );
    expect(surface).not.toBeNull();
    expect(surface?.classList.contains("mantine-Card-root")).toBe(false);
    expect(surface?.getAttribute("style")).toContain(
      "max-height: calc(100cqh - var(--mantine-spacing-xs) * 2)",
    );
    expect(
      surface?.querySelector(
        '[data-myoxus-ui-role="workbench-tool-scroll-content"]',
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Context tools")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });

    render(
      <MyoxusUIProvider>
        <ContextHarness />
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: "Context tools" }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Close" })
        .getAttribute("data-autofocus"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Selected object" }),
      ),
    );
  });
});
