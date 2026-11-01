// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { HTMLAttributes, PropsWithChildren } from "react";
import { afterEach, describe, expect, test } from "vitest";

import {
  MobileSelectorFooter,
  MobileSelectorFooterActions,
  MobileSelectorFooterInfo,
  MobileSelectorHeaderTitle,
  MobileSelectorIconSlot,
  MobileSelectorItemLabel,
  MobileSelectorList,
  MobileSelectorListItem,
  MobileSelectorRoot,
  MobileSelectorScrollArea,
  MobileSelectorScrollViewport,
  MobileSelectorTouchRail,
  Scrollable,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("mobile selector facade primitives", () => {
  test("render selector chrome through token-backed shared roles", () => {
    render(
      <MyoxusUIProvider>
        <MobileSelectorRoot data-testid="root">
          <MobileSelectorHeaderTitle>
            Choose documents
          </MobileSelectorHeaderTitle>
          <MobileSelectorScrollArea data-testid="scroll-root">
            <Scrollable.Scrollbar />
            <MobileSelectorScrollViewport data-testid="scroll-viewport">
              <MobileSelectorList data-testid="list">
                <MobileSelectorListItem data-testid="item">
                  <MobileSelectorIconSlot data-testid="checkbox-slot">
                    C
                  </MobileSelectorIconSlot>
                  <MobileSelectorIconSlot data-testid="icon-slot">
                    I
                  </MobileSelectorIconSlot>
                  <MobileSelectorItemLabel>
                    Alpha document
                  </MobileSelectorItemLabel>
                  <MobileSelectorIconSlot
                    tone="disabled"
                    data-testid="disclosure-slot"
                  >
                    D
                  </MobileSelectorIconSlot>
                </MobileSelectorListItem>
                <MobileSelectorTouchRail data-testid="touch-rail" />
              </MobileSelectorList>
            </MobileSelectorScrollViewport>
          </MobileSelectorScrollArea>
          <MobileSelectorFooter data-testid="footer">
            <MobileSelectorFooterInfo data-testid="footer-info">
              1 selected
            </MobileSelectorFooterInfo>
            <MobileSelectorFooterActions data-testid="footer-actions">
              Action
            </MobileSelectorFooterActions>
          </MobileSelectorFooter>
        </MobileSelectorRoot>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("root").dataset.myoxusUiRole).toBe(
      "mobile-selector-root",
    );
    expect(screen.getByText("Choose documents").dataset.myoxusUiRole).toBe(
      "mobile-selector-header-title",
    );
    expect(screen.getByTestId("scroll-root").dataset.myoxusUiRole).toBe(
      "mobile-selector-scroll-area",
    );
    expect(screen.getByTestId("scroll-viewport").dataset.myoxusUiRole).toBe(
      "mobile-selector-scroll-viewport",
    );
    expect(screen.getByTestId("list").dataset.myoxusUiRole).toBe(
      "mobile-selector-list",
    );
    expect(screen.getByTestId("item").dataset.myoxusUiRole).toBe(
      "mobile-selector-list-item",
    );
    expect(screen.getByTestId("checkbox-slot").dataset.myoxusUiRole).toBe(
      "mobile-selector-icon-slot",
    );
    expect(screen.getByTestId("disclosure-slot").dataset.tone).toBe("disabled");
    expect(screen.getByText("Alpha document").dataset.myoxusUiRole).toBe(
      "mobile-selector-item-label",
    );
    expect(screen.getByTestId("touch-rail").getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.getByTestId("touch-rail").getAttribute("style")).toContain(
      "var(--mantine-spacing-xl)",
    );
    expect(screen.getByTestId("footer").dataset.myoxusUiRole).toBe(
      "mobile-selector-footer",
    );
    expect(screen.getByTestId("footer-info").dataset.myoxusUiRole).toBe(
      "mobile-selector-footer-info",
    );
    expect(screen.getByTestId("footer-actions").dataset.myoxusUiRole).toBe(
      "mobile-selector-footer-actions",
    );
  });

  test("can render list-item chrome on a polymorphic link root", () => {
    const LinkRoot = ({
      children,
      to,
      ...props
    }: PropsWithChildren<
      { to: string } & HTMLAttributes<HTMLAnchorElement>
    >) => (
      <a {...props} href={to}>
        {children}
      </a>
    );

    render(
      <MyoxusUIProvider>
        <MobileSelectorListItem
          component={LinkRoot}
          to="/collections/alpha"
          data-testid="link-item"
        >
          <MobileSelectorItemLabel>Alpha collection</MobileSelectorItemLabel>
        </MobileSelectorListItem>
      </MyoxusUIProvider>,
    );

    const item = screen.getByRole("link", { name: "Alpha collection" });
    expect(item).toBe(screen.getByTestId("link-item"));
    expect(item.dataset.myoxusUiRole).toBe("mobile-selector-list-item");
    expect(item.getAttribute("style")).toContain("text-decoration: none");
    expect(item.getAttribute("style")).toContain("width: 100%");
  });
});
