// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SplitViewDragHandleChrome,
  SplitViewFolderWarning,
  SplitViewIndicatorFrame,
  SplitViewIndicatorMenuAnchor,
  SplitViewPanelContent,
  SplitViewPanelDragSurface,
  SplitViewPanelFrame,
  SplitViewResizeHandle,
  SplitViewRoot,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("split-view facade primitives", () => {
  test("render workbench split-view chrome through token-backed roles", () => {
    const openMenu = vi.fn();

    render(
      <MyoxusUIProvider>
        <SplitViewRoot clientBorder data-testid="root" orientation="horizontal">
          <SplitViewPanelFrame
            data-is-active
            data-is-first
            data-testid="panel"
            panelOrder={2}
            panelSize={1.5}
          >
            <SplitViewResizeHandle
              data-can-resize
              data-edge="left"
              data-is-first
              data-state="idle"
              data-testid="handle"
            />
            <SplitViewPanelDragSurface
              data-is-active
              data-testid="drag-surface"
            >
              <SplitViewPanelContent data-testid="content">
                Document
              </SplitViewPanelContent>
              <SplitViewIndicatorFrame data-testid="indicator">
                <SplitViewIndicatorMenuAnchor data-testid="menu-anchor" />
                <SplitViewDragHandleChrome
                  active
                  data-testid="drag-handle"
                  onOpenMenu={openMenu}
                />
              </SplitViewIndicatorFrame>
            </SplitViewPanelDragSurface>
          </SplitViewPanelFrame>
        </SplitViewRoot>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("root").dataset.myoxusUiRole).toBe(
      "split-view-root",
    );
    expect(screen.getByTestId("root").dataset.clientBorder).toBe("true");
    expect(screen.getByTestId("panel").dataset.myoxusUiRole).toBe(
      "split-view-panel",
    );
    expect(screen.getByTestId("panel").getAttribute("style")).toContain(
      "--myoxus-ui-split-view-panel-size: 1.5",
    );
    expect(screen.getByTestId("panel").getAttribute("style")).toContain(
      "--myoxus-ui-split-view-panel-order: 2",
    );
    expect(screen.getByTestId("handle").dataset.myoxusUiRole).toBe(
      "split-view-resize-handle",
    );
    expect(screen.getByTestId("drag-surface").dataset.myoxusUiRole).toBe(
      "split-view-panel-drag-surface",
    );
    expect(screen.getByTestId("content").dataset.myoxusUiRole).toBe(
      "split-view-panel-content",
    );
    expect(screen.getByTestId("indicator").dataset.myoxusUiRole).toBe(
      "split-view-indicator",
    );
    expect(screen.getByTestId("menu-anchor").dataset.myoxusUiRole).toBe(
      "split-view-indicator-menu-anchor",
    );
    expect(screen.getByTestId("drag-handle").dataset.myoxusUiRole).toBe(
      "split-view-drag-handle",
    );
    expect(
      document.querySelectorAll(
        '[data-myoxus-ui-role="split-view-drag-handle-dot"]',
      ),
    ).toHaveLength(3);

    fireEvent.click(screen.getByTestId("drag-handle"));
    expect(openMenu).toHaveBeenCalledTimes(1);
  });

  test("keeps folder warning layout in the facade instead of product CSS", () => {
    render(
      <MyoxusUIProvider>
        <SplitViewFolderWarning data-testid="warning">
          <p>Folder drops open a warning.</p>
        </SplitViewFolderWarning>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("warning").dataset.myoxusUiRole).toBe(
      "split-view-folder-warning",
    );
  });
});
