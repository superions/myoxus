// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Scrollable } from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("facade scrollable container", () => {
  afterEach(() => {
    cleanup();
  });

  test("Scrollable.Viewport forwards scroll handlers and accessibility props to the real viewport", () => {
    const handleScroll = vi.fn();
    const { container } = renderWithProvider(
      <Scrollable.Root style={{ height: 120 }}>
        <Scrollable.Viewport
          aria-label="Documents list"
          className="documents-scroll"
          onScroll={handleScroll}
        >
          <div style={{ height: 400 }}>Long document list</div>
        </Scrollable.Viewport>
      </Scrollable.Root>,
    );

    const viewport = screen.getByLabelText("Documents list");
    const scrollAreaRoot = container.querySelector(
      "[data-myoxus-ui-role='settings-scroll-viewport']",
    ) as HTMLElement | null;

    expect(scrollAreaRoot).not.toBeNull();
    expect(scrollAreaRoot).not.toBe(viewport);
    expect(scrollAreaRoot?.classList.contains("documents-scroll")).toBe(true);
    expect(scrollAreaRoot?.style.height).toBe("100%");
    expect(scrollAreaRoot?.style.minHeight).toBe("0");
    expect(scrollAreaRoot?.style.minWidth).toMatch(/^0(?:rem)?$/);
    expect(scrollAreaRoot?.style.width).toBe("100%");
    expect(
      container.querySelector<HTMLElement>(
        "[data-myoxus-ui-role='settings-scroll-root']",
      )?.style.minWidth,
    ).toMatch(/^0(?:rem)?$/);
    expect((viewport as HTMLElement).tabIndex).toBe(0);

    fireEvent.scroll(viewport);
    expect(handleScroll).toHaveBeenCalledTimes(1);
  });

  test("Scrollable.VirtualizedViewport keeps ref, scroll props and children on one element", () => {
    const handleScroll = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const { container } = renderWithProvider(
      <Scrollable.VirtualizedViewport
        ref={ref}
        className="virtualized-scroll"
        data-testid="virtualized-scroll"
        onScroll={handleScroll}
      >
        <div>Virtualized child</div>
      </Scrollable.VirtualizedViewport>,
    );

    const viewport = screen.getByTestId("virtualized-scroll");

    expect(ref.current).toBe(viewport);
    expect(viewport.contains(screen.getByText("Virtualized child"))).toBe(true);
    expect(viewport.getAttribute("data-myoxus-ui-role")).toBe(
      "virtualized-scroll-viewport",
    );
    expect((viewport as HTMLElement).style.overflowY).toBe("auto");
    expect(
      container
        .querySelector(".virtualized-scroll")
        ?.getAttribute("data-testid"),
    ).toBe("virtualized-scroll");

    fireEvent.scroll(viewport);
    expect(handleScroll).toHaveBeenCalledTimes(1);
  });

  test("Scrollable.Viewport autosizes selector content up to the theme cap", () => {
    const { container } = renderWithProvider(
      <Scrollable.Viewport autosize maxHeight="selector">
        <div>Compact selector content</div>
      </Scrollable.Viewport>,
    );

    const scrollAreaRoot = container.querySelector<HTMLElement>(
      "[data-myoxus-ui-role='settings-scroll-viewport']",
    );
    expect(scrollAreaRoot?.style.height).toBe("");
    expect(scrollAreaRoot?.style.maxHeight).toBe(
      "calc(25rem * var(--mantine-scale))",
    );
  });
});
