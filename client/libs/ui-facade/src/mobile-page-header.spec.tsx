// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  MobileJournalDatePickerFrame,
  MobilePageHeaderBar,
  MobilePageHeaderContent,
  MobilePageHeaderPrefix,
  MobilePageHeaderRoot,
  MobilePageHeaderSpacer,
  MobilePageHeaderSuffix,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("MobilePageHeader facade", () => {
  test("owns mobile header slots and spacer geometry", () => {
    render(
      <MyoxusUIProvider>
        <MobilePageHeaderRoot data-testid="root">
          <MobilePageHeaderBar>
            <MobilePageHeaderPrefix>Back</MobilePageHeaderPrefix>
            <MobilePageHeaderContent layout="detail">
              Title
            </MobilePageHeaderContent>
            <MobilePageHeaderSuffix>Actions</MobilePageHeaderSuffix>
          </MobilePageHeaderBar>
        </MobilePageHeaderRoot>
        <MobilePageHeaderSpacer
          data-testid="spacer"
          size="journal-date-picker"
        />
        <MobileJournalDatePickerFrame data-testid="journal-frame">
          Journal
        </MobileJournalDatePickerFrame>
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("root");
    expect(root.dataset.myoxusUiRole).toBe("mobile-page-header");
    expect(root.style.position).toBe("fixed");
    expect(screen.getByText("Back").dataset.myoxusUiRole).toBe(
      "mobile-page-header-prefix",
    );
    expect(screen.getByText("Title").dataset.centered).toBe("true");
    expect(screen.getByText("Title").dataset.layout).toBe("detail");
    expect(screen.getByText("Actions").dataset.myoxusUiRole).toBe(
      "mobile-page-header-suffix",
    );
    expect(screen.getByTestId("spacer").dataset.myoxusUiRole).toBe(
      "mobile-page-header-spacer",
    );
    expect(screen.getByTestId("spacer").dataset.size).toBe(
      "journal-date-picker",
    );
    expect(screen.getByTestId("journal-frame").dataset.myoxusUiRole).toBe(
      "mobile-journal-date-picker",
    );
  });
});
