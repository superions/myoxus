// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { MobileAppFallback } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("MobileAppFallback facade", () => {
  test("owns the mobile hydration skeleton shell and keeps workspace content slotted", () => {
    render(
      <MyoxusUIProvider>
        <MobileAppFallback
          workspaceSelector={<div data-testid="workspace">Workspace</div>}
        />
      </MyoxusUIProvider>,
    );

    const root = screen
      .getByTestId("workspace")
      .closest("[data-myoxus-ui-role]");
    expect(root?.getAttribute("data-myoxus-ui-role")).toBe(
      "mobile-app-fallback-workspace",
    );
    expect(
      document.querySelector('[data-myoxus-ui-role="mobile-app-fallback"]'),
    ).toBeDefined();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-app-fallback-actions"]',
      ),
    ).toBeDefined();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-app-fallback-search"]',
      ),
    ).toBeDefined();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-app-fallback-recent-rail"]',
      ),
    ).toBeDefined();
    expect(
      document.querySelectorAll(
        '[data-myoxus-ui-role="mobile-app-fallback-section-row"]',
      ),
    ).toHaveLength(8);
  });
});
