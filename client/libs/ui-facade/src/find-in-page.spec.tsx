// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  FindInPageAnchor,
  FindInPageCanvasText,
  FindInPageCloseButton,
  FindInPageCount,
  FindInPageInputMain,
  FindInPageNavButton,
  FindInPageNavGroup,
  FindInPagePanel,
  FindInPageSearchBox,
  FindInPageSearchIconSlot,
  FindInPageTextInput,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("find-in-page facade primitives", () => {
  test("render popup chrome through native Paper, Group and action roles", () => {
    render(
      <MyoxusUIProvider>
        <FindInPageAnchor data-testid="anchor">
          <FindInPagePanel opened data-testid="panel">
            <FindInPageSearchBox active data-testid="search-box">
              <FindInPageSearchIconSlot data-testid="search-icon">
                S
              </FindInPageSearchIconSlot>
              <FindInPageInputMain data-testid="input-main">
                <FindInPageTextInput
                  aria-label="Find in page"
                  value="alpha"
                  onChange={() => {}}
                />
                <FindInPageCanvasText data-testid="canvas-text" />
              </FindInPageInputMain>
              <FindInPageCount data-testid="count">2/5</FindInPageCount>
            </FindInPageSearchBox>
            <FindInPageNavGroup data-testid="nav-group">
              <FindInPageNavButton
                aria-label="Previous match"
                edge="start"
                icon="Up"
              />
              <FindInPageNavButton aria-label="Next match" icon="Down" />
            </FindInPageNavGroup>
            <FindInPageCloseButton aria-label="Close find in page" icon="X" />
          </FindInPagePanel>
        </FindInPageAnchor>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("anchor").dataset.myoxusUiRole).toBe(
      "find-in-page-anchor",
    );
    expect(screen.getByTestId("panel").dataset.myoxusUiRole).toBe(
      "find-in-page-panel",
    );
    expect(screen.getByTestId("panel").className).toContain(
      "mantine-Paper-root",
    );
    expect(screen.getByTestId("panel").className).toContain(
      "mantine-Group-root",
    );
    expect(screen.getByTestId("nav-group").className).toContain(
      "mantine-ActionIconGroup-group",
    );
    expect(screen.getByTestId("panel").getAttribute("style")).toContain(
      "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
    );
    expect(screen.getByTestId("search-box").dataset.active).toBe("true");
    expect(screen.getByTestId("search-icon").dataset.myoxusUiRole).toBe(
      "find-in-page-search-icon",
    );
    expect(screen.getByTestId("input-main").dataset.myoxusUiRole).toBe(
      "find-in-page-input-main",
    );
    expect(
      screen
        .getByRole("textbox", { name: "Find in page" })
        .closest("[data-myoxus-ui-role='find-in-page-input']"),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="find-in-page-input-shell"]',
      ),
    ).not.toBeNull();
    expect(screen.getByTestId("canvas-text").getAttribute("style")).toContain(
      "var(--mantine-font-family-body-small, var(--mantine-font-family))",
    );
    expect(screen.getByTestId("count").dataset.myoxusUiRole).toBe(
      "find-in-page-count",
    );
    expect(screen.getByTestId("nav-group").dataset.myoxusUiRole).toBe(
      "find-in-page-nav-group",
    );
    expect(
      screen.getByRole("button", { name: "Previous match" }).dataset
        .myoxusUiRole,
    ).toBe("find-in-page-nav-button");
    expect(
      screen.getByRole("button", { name: "Close find in page" }).dataset
        .myoxusUiRole,
    ).toBe("find-in-page-close-button");
  });

  test("keeps hidden input and canvas mirror typography owned by the facade", () => {
    render(
      <MyoxusUIProvider>
        <FindInPageInputMain>
          <FindInPageTextInput
            aria-label="Find in page"
            onChange={() => {}}
            searching
            value="alpha"
          />
          <FindInPageCanvasText data-testid="canvas-text" />
        </FindInPageInputMain>
      </MyoxusUIProvider>,
    );

    const inputShell = document.querySelector(
      '[data-myoxus-ui-role="find-in-page-input-shell"]',
    );
    expect(inputShell?.getAttribute("style")).toContain("visibility: hidden");
    expect(screen.getByTestId("canvas-text").getAttribute("style")).toContain(
      "var(--mantine-font-family-body-small, var(--mantine-font-family))",
    );
  });
});
