// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { MobileDocInfoSheetRoot, MobileDocInfoSheetViewport } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("MobileDocInfoSheet facade", () => {
  test("owns mobile document info sheet chrome without product-local CSS", () => {
    render(
      <MyoxusUIProvider>
        <MobileDocInfoSheetRoot data-testid="root">
          <MobileDocInfoSheetViewport data-testid="viewport">
            Metadata
          </MobileDocInfoSheetViewport>
        </MobileDocInfoSheetRoot>
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("root");
    const viewport = screen.getByTestId("viewport");

    expect(root.dataset.myoxusUiRole).toBe("mobile-doc-info-sheet-root");
    expect(root.style.display).toBe("flex");
    expect(root.style.flexDirection).toBe("column");
    expect(viewport.dataset.myoxusUiRole).toBe(
      "mobile-doc-info-sheet-viewport",
    );
    expect(viewport.style.padding).toMatch(
      /^0(?:px)? var\(--mantine-spacing-sm\)$/,
    );
    expect(screen.getByText("Metadata")).not.toBeNull();
  });
});
