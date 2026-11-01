// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import {
  shellPanelSizes,
  ShellSidebarPanel,
  ShellRightPanel,
  Splitter,
  type SplitterPaneSize,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("native Splitter handles keep both navigation states fixed and bound detail resizing", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1280,
    bottom: 900,
    width: 1280,
    height: 900,
    toJSON: () => ({}),
  });
  const onSizeChange = vi.fn();
  const frame = (navigation: SplitterPaneSize) => (
    <MyoxusUIProvider>
      <Splitter sizes={[navigation, 55, 30]} onSizeChange={onSizeChange}>
        <ShellSidebarPanel
          defaultSize={navigation}
          min={navigation}
          max={navigation}
        >
          Navigation
        </ShellSidebarPanel>
        <Splitter.Pane defaultSize={85} min="50%">
          Main
        </Splitter.Pane>
        <ShellRightPanel
          defaultSize={0}
          min={0}
          max={shellPanelSizes.detailMax}
          collapsible
        >
          Details
        </ShellRightPanel>
      </Splitter>
    </MyoxusUIProvider>
  );
  const { rerender } = render(frame(shellPanelSizes.navigationExpanded));
  for (const navigation of [
    shellPanelSizes.navigationExpanded,
    shellPanelSizes.navigationCollapsed,
  ]) {
    rerender(frame(navigation));
    const [railHandle, detailHandle] = screen.getAllByRole("separator");
    fireEvent.keyDown(railHandle, { key: "ArrowRight", shiftKey: true });
    expect(onSizeChange.mock.lastCall?.[0][0]).toBe(navigation);
    // Keyboard resizing exercises the native bounds, rather than a CSS cap hiding an
    // unconstrained resize behind the same-looking navigation frame.
    fireEvent.keyDown(detailHandle, { key: "Home" });
    const next = onSizeChange.mock.lastCall?.[0];
    expect(next[0]).toBe(navigation);
    expect(next[2]).toBeGreaterThan(0);
    expect(next[2]).toBeLessThanOrEqual(30);
  }
});
