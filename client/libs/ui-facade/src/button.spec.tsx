// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { MyoxusButton } from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("facade button accessible names", () => {
  afterEach(() => {
    cleanup();
  });

  test("keeps visible nested text as the accessible name instead of data-testid fallback", () => {
    renderWithProvider(
      <MyoxusButton data-testid="confirm-dialog-confirm">
        <span>Reindex</span>
      </MyoxusButton>,
    );

    expect(screen.getByRole("button", { name: "Reindex" })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "confirm dialog confirm" }),
    ).toBeNull();
  });

  test("uses the test-id fallback only for icon-only buttons without visible text", () => {
    renderWithProvider(
      <MyoxusButton data-testid="workspace-menu">
        <span aria-hidden="true" />
      </MyoxusButton>,
    );

    expect(
      screen.getByRole("button", { name: "workspace menu" }),
    ).not.toBeNull();
  });

  test("overrides Mantine button variables with Myoxus semantic token pairs", () => {
    renderWithProvider(
      <MyoxusButton data-testid="plain-action" variant="plain">
        Create first
      </MyoxusButton>,
    );

    const button = screen.getByTestId("plain-action");

    expect(button.style.getPropertyValue("--button-color")).toContain(
      "--myoxus-sem-button-plain-fg",
    );
    expect(button.style.getPropertyValue("--button-color")).toContain(
      "--myoxus-link-color",
    );
    expect(button.style.getPropertyValue("--button-bg")).toBe("transparent");
    expect(button.style.getPropertyValue("--button-hover-color")).toContain(
      "--myoxus-sem-button-plain-fg",
    );
  });

  test("disabled buttons use disabled token pairs instead of active primary chrome", () => {
    renderWithProvider(
      <MyoxusButton data-testid="disabled-action" variant="primary" disabled>
        Add
      </MyoxusButton>,
    );

    const button = screen.getByTestId("disabled-action");

    expect(button.style.getPropertyValue("--button-bg")).toContain(
      "--myoxus-sem-button-disabled-bg",
    );
    expect(button.style.getPropertyValue("--button-color")).toContain(
      "--myoxus-sem-button-disabled-fg",
    );
    expect(button.style.getPropertyValue("--button-color")).toContain(
      "--myoxus-text-secondary-color",
    );
    expect(button.style.getPropertyValue("--button-color")).not.toContain(
      "--myoxus-text-disable-color",
    );
    expect(button.style.cursor).toBe("not-allowed");
  });
});
