// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MOBILE_SEARCH_VIEW_TRANSITION_NAME,
  MobileSearchCancelButton,
  MobileSearchEmpty,
  MobileSearchError,
  MobileSearchHeader,
  MobileSearchInput,
  MobileSearchList,
  MobileSearchResultsTitle,
  MobileSearchSection,
  MobileSearchSectionTitle,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("Mobile Search native Mantine structure", () => {
  test("renders search layout, states and interaction through native primitives", () => {
    const cancel = vi.fn();
    const input = vi.fn();

    render(
      <MyoxusUIProvider>
        <MobileSearchHeader data-testid="header">
          <MobileSearchInput
            aria-label="Search"
            data-testid="input"
            onInput={input}
            value="design"
          />
          <MobileSearchCancelButton onClick={cancel}>
            Clear
          </MobileSearchCancelButton>
        </MobileSearchHeader>
        <MobileSearchResultsTitle data-testid="results-title">
          Search results
        </MobileSearchResultsTitle>
        <MobileSearchSection data-testid="section">
          <MobileSearchSectionTitle>Collections</MobileSearchSectionTitle>
          <MobileSearchList data-testid="list">
            <div>Design resources</div>
          </MobileSearchList>
        </MobileSearchSection>
        <MobileSearchEmpty>No recent items</MobileSearchEmpty>
        <MobileSearchError>Search unavailable</MobileSearchError>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("header").firstElementChild?.className).toContain(
      "mantine-Group-root",
    );
    expect(screen.getByTestId("section").className).toContain(
      "mantine-Stack-root",
    );
    expect(screen.getByTestId("list").className).toContain(
      "mantine-Stack-root",
    );
    expect(
      document.querySelector('[data-myoxus-ui-role="mobile-search-empty"]')
        ?.className,
    ).toContain("mantine-Center-root");

    const searchInput = screen.getByTestId("input") as HTMLInputElement;
    const inputRoot = searchInput.closest(".mantine-TextInput-root");
    expect((inputRoot as HTMLElement | null)?.style.viewTransitionName).toBe(
      MOBILE_SEARCH_VIEW_TRANSITION_NAME,
    );

    fireEvent.change(searchInput, { target: { value: "design system" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(input).toHaveBeenCalledWith("design system");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
