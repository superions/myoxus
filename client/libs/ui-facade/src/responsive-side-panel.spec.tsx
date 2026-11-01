// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ResponsiveSidePanel } from "./index";
import { MyoxusUIProvider } from "./provider";

const originalMatchMedia = window.matchMedia;

describe("ResponsiveSidePanel", () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  test("keeps native drawer stacking so portalled overlays can render above it", () => {
    render(
      <MyoxusUIProvider>
        <ResponsiveSidePanel opened onOpenChange={() => undefined} side="right">
          Panel content
        </ResponsiveSidePanel>
      </MyoxusUIProvider>,
    );

    const root = screen.getByRole("dialog").closest(".mantine-Drawer-root");
    expect(root).not.toBeNull();
    expect((root as HTMLElement).style.zIndex).toBe("");
    expect(
      (root?.querySelector(".mantine-Drawer-overlay") as HTMLElement | null)
        ?.style.zIndex,
    ).toBe("");
    expect(
      (root?.querySelector(".mantine-Drawer-inner") as HTMLElement | null)
        ?.style.zIndex,
    ).toBe("");
    expect(
      root?.querySelector<HTMLElement>(
        '[data-myoxus-responsive-side-panel="true"]',
      )?.style.height,
    ).toBe("100%");
  });
});
