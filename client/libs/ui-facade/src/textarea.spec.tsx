// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Textarea } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("Facade Textarea", () => {
  test("owns technical monospace textarea styling through Mantine theme variables", () => {
    render(
      <MyoxusUIProvider>
        <Textarea label="Private key" mono />
      </MyoxusUIProvider>,
    );

    const input = screen.getByLabelText("Private key");
    const root = input.closest("[data-myoxus-ui-role='form-textarea:mono']");
    expect(root).not.toBeNull();
    expect(input.getAttribute("style") ?? "").toContain(
      "--mantine-font-family-monospace",
    );
  });
});
