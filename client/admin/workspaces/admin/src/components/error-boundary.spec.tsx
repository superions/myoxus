import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string) => key),
}));
vi.mock("@myoxus/i18n", async () => {
  const { createI18nMock } = await import("../__tests__/test-utils");
  return createI18nMock(tMock);
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  tMock.mockClear();
  vi.restoreAllMocks();
});

import { AppErrorBoundary, PageErrorBoundary } from "./error-boundary";

function ThrowOnRender({ message }: { message: string }): never {
  throw new Error(message);
}

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("P114-A-03 PageErrorBoundary", () => {
  test("offers explicit reload when remounting cannot recover a cached failure", () => {
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => undefined);
    renderWithFacade(
      <PageErrorBoundary>
        <ThrowOnRender message="Persistent render failure" />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "admin.error.page-failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "admin.error.retry" }));
    expect(screen.getByText("Persistent render failure").textContent).toBe(
      "Persistent render failure",
    );
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "admin.error.reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  test("inv_p114a03_03: retry button resets boundary state so fixed children render", () => {
    let shouldThrow = true;

    function MaybeThrow() {
      if (shouldThrow) throw new Error("transient failure");
      return <div data-testid="content">recovered</div>;
    }

    const { rerender } = renderWithFacade(
      <PageErrorBoundary>
        <MaybeThrow />
      </PageErrorBoundary>,
    );

    const retryButton = screen.getByRole("button", {
      name: "admin.error.retry",
    });
    expect(retryButton).toBeTruthy();

    shouldThrow = false;
    retryButton.click();

    rerender(
      <MyoxusUIProvider>
        <PageErrorBoundary>
          <MaybeThrow />
        </PageErrorBoundary>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("content").textContent).toBe("recovered");
  });
});

describe("AppErrorBoundary", () => {
  test("inv_p114a03_06: top-level fallback uses shared facade roles", () => {
    const { container } = renderWithFacade(
      <AppErrorBoundary>
        <ThrowOnRender message="fatal bootstrap failure" />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("admin.error.app-failed")).toBeTruthy();
    expect(screen.getByText("admin.error.app-failed-desc")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "admin.error.reload" }),
    ).toBeTruthy();
    expect(screen.getByText(/fatal bootstrap failure/)).toBeTruthy();
    expect(
      container.querySelector(
        '[data-myoxus-ui-role="exception-boundary-frame"][data-myoxus-ui-scope="app"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector('[class*="admin-error-boundary"]'),
    ).toBeNull();
  });
});
