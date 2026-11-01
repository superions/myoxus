// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { NavigationLink } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(cleanup);

describe("NavigationLink", () => {
  test("blocks disabled button actions instead of applying visual state only", () => {
    const onClick = vi.fn();
    render(
      <MyoxusUIProvider>
        <NavigationLink
          component="button"
          type="button"
          label="Name"
          description="Text"
          aria-label="Field settings: Name"
          disabled
          onClick={onClick}
        />
      </MyoxusUIProvider>,
    );

    const action = screen.getByRole("button", {
      name: "Field settings: Name",
    });
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(action.tabIndex).toBe(-1);
    fireEvent.click(action);
    expect(onClick).not.toHaveBeenCalled();
  });
});
