// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigModal } from "./index";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      Done: () => "Done",
    }) as never,
}));

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

afterEach(() => cleanup());

describe("ConfigModal facade migration", () => {
  test("renders fullscreen page chrome through shared facade roles", () => {
    const onDone = vi.fn();

    renderWithProvider(
      <ConfigModal
        open
        onOpenChange={vi.fn()}
        onDone={onDone}
        title="Mobile settings"
      >
        <ConfigModal.RowGroup title="General">
          <ConfigModal.Row right={<span>On</span>}>Sync</ConfigModal.Row>
        </ConfigModal.RowGroup>
      </ConfigModal>,
    );

    expect(screen.getByTestId("mobile-page-header")).toBeTruthy();
    expect(screen.getByText("Mobile settings").dataset.myoxusUiRole).toBe(
      "mobile-config-modal-page-title",
    );
    expect(screen.getByText("General").dataset.myoxusUiRole).toBe(
      "mobile-config-modal-row-group-title",
    );
    expect(
      screen
        .getByText("Sync")
        .closest("[data-myoxus-ui-role]")
        ?.getAttribute("data-myoxus-ui-role"),
    ).toBe("mobile-config-modal-row");
    expect(
      screen
        .getByText("On")
        .closest("[data-myoxus-ui-role]")
        ?.getAttribute("data-myoxus-ui-role"),
    ).toBe("surface-list-selection-slot");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("renders popup chrome and action through facade primitives", () => {
    const onDone = vi.fn();

    renderWithProvider(
      <ConfigModal
        open
        onOpenChange={vi.fn()}
        onDone={onDone}
        title="Choose color"
        variant="popup"
      >
        <ConfigModal.Row tone="danger">Delete tag</ConfigModal.Row>
      </ConfigModal>,
    );

    expect(screen.getByText("Choose color").dataset.myoxusUiRole).toBe(
      "mobile-config-modal-popup-title",
    );
    expect(
      screen
        .getByText("Delete tag")
        .closest("[data-surface-tone]")
        ?.getAttribute("data-surface-tone"),
    ).toBe("danger");
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-config-modal-popup-actions"]',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
