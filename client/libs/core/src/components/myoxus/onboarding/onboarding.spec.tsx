/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Onboarding } from "./onboarding";

function renderOnboarding(onOpenApp = vi.fn()) {
  render(
    <MyoxusUIProvider>
      <Onboarding onOpenApp={onOpenApp} />
    </MyoxusUIProvider>,
  );
  return onOpenApp;
}

describe("Electron onboarding", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            appServerBranding: {
              productMark: { publicUrl: "/style/product-mark.svg" },
            },
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("renders through shared onboarding facade roles", () => {
    renderOnboarding();

    expect(screen.getByText("Workspace-first knowledge work")).toBeTruthy();
    expect(
      screen.getByText("Bring your workspace material together"),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="onboarding-main"]'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="onboarding-shell:default"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="onboarding-progress-list"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="electron-onboarding-step"]',
      ),
    ).toBeTruthy();
  });

  test("uses facade actions for the tour flow and final open action", () => {
    const onOpenApp = renderOnboarding();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByText(
        "Move from writing to structure without switching products",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByText("Bring your workspace material together"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Open Myoxus" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Myoxus" }));
    expect(onOpenApp).toHaveBeenCalledTimes(1);
  });
});
