// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { MobileSignInLayout } from "./layout";

describe("MobileSignInLayout", () => {
  test("renders mobile sign-in content through the shared auth facade shell", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <MobileSignInLayout>
          <button type="button">Continue</button>
        </MobileSignInLayout>
      </MyoxusUIProvider>,
    );

    expect(
      container.querySelector('[data-testid="auth-background-hedge"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-myoxus-ui-role="sign-in-page-container"]'),
    ).toBeTruthy();
    const content = screen
      .getByText("Continue")
      .closest("[data-myoxus-ui-role]") as HTMLElement | null;
    expect(content?.dataset.myoxusUiRole).toBe("mobile-sign-in-content");
  });
});
