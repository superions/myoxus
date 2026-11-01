// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ErrorDetail, ErrorStatus } from "./error-detail";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => () => String(key),
      },
    ),
}));

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

afterEach(() => cleanup());

describe("ErrorDetail facade migration", () => {
  test("renders crash chrome through shared exception-boundary facade roles", () => {
    renderWithProvider(
      <ErrorDetail
        buttonText="Retry"
        description={["The route failed", "Try again after reloading."]}
        status={ErrorStatus.Unexpected}
        title="Unexpected error"
      />,
    );

    expect(screen.getByTestId("error-detail")).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="exception-boundary-detail-layout"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="exception-boundary-detail-surface"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="exception-boundary-illustration"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="exception-boundary-copy"]'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="exception-boundary-actions"]',
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test("keeps stack trace disclosure functional without product CSS", () => {
    renderWithProvider(
      <ErrorDetail
        buttonText="Retry"
        description="The route failed"
        error={new Error("boom")}
        status={ErrorStatus.Unexpected}
        title="Unexpected error"
      />,
    );

    const stackShell = document.querySelector(
      '[data-myoxus-ui-role="exception-boundary-stack-trace:shell"]',
    );
    expect(stackShell?.getAttribute("aria-hidden")).toBe("true");
    expect(stackShell?.getAttribute("data-expanded")).toBe("false");

    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.error.hide-error",
      }),
    );

    expect(stackShell?.getAttribute("data-expanded")).toBe("true");
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="exception-boundary-stack-trace"]',
      )?.textContent,
    ).toContain("boom");
  });

  test("marks not-found errors with the stable route test id", () => {
    renderWithProvider(
      <ErrorDetail
        buttonText="Back"
        description="The document no longer exists."
        status={ErrorStatus.NotFound}
        title="Not found"
      />,
    );

    expect(screen.getByTestId("not-found")).toBeTruthy();
    expect(screen.getByTestId("not-found").dataset.myoxusErrorStatus).toBe(
      String(ErrorStatus.NotFound),
    );
  });
});
