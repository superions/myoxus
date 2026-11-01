// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { BrowserWarning, LocalDemoTips } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("top-tip banner facade primitives", () => {
  test("renders browser warnings without the retired banner CSS classes", () => {
    const onClose = vi.fn();
    const { container } = render(
      <MyoxusUIProvider>
        <BrowserWarning show onClose={onClose} message="Unsupported browser" />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Unsupported browser")).not.toBeNull();
    expect(
      container.querySelector('[data-myoxus-ui-role="browser-warning"]'),
    ).not.toBeNull();
    expect(
      container.querySelector("[class*='myoxus-ui-browser-warning']"),
    ).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("renders local demo tips through facade roles and actions", () => {
    const onClose = vi.fn();
    const onLogin = vi.fn();
    const onEnableCloud = vi.fn();
    const { container } = render(
      <MyoxusUIProvider>
        <LocalDemoTips
          isLoggedIn={false}
          onClose={onClose}
          onEnableCloud={onEnableCloud}
          onLogin={onLogin}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("local-demo-tips")).not.toBeNull();
    expect(
      container.querySelector('[data-myoxus-ui-role="local-demo-tips"]'),
    ).not.toBeNull();
    expect(
      container.querySelector("[class*='myoxus-ui-local-demo-tips']"),
    ).toBe(null);

    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onEnableCloud).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("local-demo-tips-close-button"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
