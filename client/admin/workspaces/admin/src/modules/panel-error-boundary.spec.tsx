import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "admin.config.error.load-failed": "Failed to load configuration",
        "admin.config.error.load-failed-desc":
          "An error occurred loading configuration data.",
        "admin.error.retry": "Retry",
      })[key] ?? key,
  }),
}));

// Suppress React's console.error for intentional throws

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import { PageConfigErrorBoundary } from "../components/page-config-error-boundary";

function renderWithUiProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("P116-B right-panel error boundary", () => {
  test("inv_p116b_03: retry button resets boundary and re-renders children", () => {
    let shouldThrow = true;

    function MaybeThrow() {
      if (shouldThrow) throw new Error("transient error");
      return <div data-testid="content">recovered</div>;
    }

    const { rerender } = renderWithUiProvider(
      <PageConfigErrorBoundary>
        <MaybeThrow />
      </PageConfigErrorBoundary>,
    );

    // Error state: error card visible
    const retryButton = screen.getByRole("button", { name: /Retry/i });
    expect(retryButton).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("transient error");
    expect(
      screen.getByRole("heading", {
        name: "Failed to load configuration",
        level: 3,
      }),
    ).not.toBeNull();

    // Fix the underlying issue and click retry
    shouldThrow = false;
    retryButton.click();

    rerender(
      <MyoxusUIProvider>
        <PageConfigErrorBoundary>
          <MaybeThrow />
        </PageConfigErrorBoundary>
      </MyoxusUIProvider>,
    );

    // Content is now visible instead of error card
    expect(screen.getByTestId("content").textContent).toBe("recovered");
  });
});
