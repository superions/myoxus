// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  MobileAppTabsItem,
  MobileAppTabsList,
  MobileAppTabsRoot,
} from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

afterEach(() => cleanup());

describe("mobile AppTabs and All Docs facade migration contract", () => {
  test("renders mobile AppTabs semantics through Facade roles", () => {
    render(
      <MyoxusUIProvider>
        <MobileAppTabsRoot data-testid="root" fixed={false} hidden>
          <MobileAppTabsList data-testid="list">
            <MobileAppTabsItem active aria-label="Home" data-testid="home">
              H
            </MobileAppTabsItem>
            <MobileAppTabsItem aria-label="All docs" data-testid="all">
              A
            </MobileAppTabsItem>
          </MobileAppTabsList>
        </MobileAppTabsRoot>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("root").dataset.myoxusUiRole).toBe(
      "mobile-app-tabs",
    );
    expect(screen.getByTestId("root").getAttribute("style")).toContain(
      "visibility: hidden",
    );
    expect(screen.getByTestId("list").getAttribute("role")).toBe("tablist");
    expect(screen.getByTestId("home").getAttribute("role")).toBe("tab");
    expect(screen.getByTestId("home").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByTestId("all").getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByTestId("home").getAttribute("style")).toContain(
      "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
    );
  });
});
