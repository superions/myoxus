// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { NumberInput } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("Facade NumberInput", () => {
  test("marks root and internal steppers as shared facade controls", () => {
    render(
      <MyoxusUIProvider>
        <NumberInput label="Size" value={12} />
      </MyoxusUIProvider>,
    );

    const input = screen.getByLabelText("Size");
    const root = input.closest("[data-myoxus-ui-role='form-number-input']");
    expect(root).not.toBeNull();
    const controls = document.querySelectorAll(
      ".myoxus-ui-number-input-control",
    );
    expect(controls.length).toBeGreaterThanOrEqual(2);
  });
});
