// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vitest";

import { MyoxusUIProvider } from "./provider";
import {
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SelectionCardGrid,
  SelectionCardSkeletonGrid,
} from "./radio-card";

function RadioCardHarness() {
  const [value, setValue] = useState("table");
  return (
    <MyoxusUIProvider>
      <RadioCardGroup value={value} onChange={setValue} label="Choose a view">
        <SelectionCardGrid>
          <RadioCard value="table">
            <RadioCardIndicator />
            Table
          </RadioCard>
          <RadioCard value="kanban">
            <RadioCardIndicator />
            Kanban
          </RadioCard>
        </SelectionCardGrid>
      </RadioCardGroup>
    </MyoxusUIProvider>
  );
}

describe("Facade radio selection cards", () => {
  test("keeps selection and arrow-key behavior on native Mantine radio cards", () => {
    render(<RadioCardHarness />);

    const table = screen.getByRole("radio", { name: /table/i });
    const kanban = screen.getByRole("radio", { name: /kanban/i });
    expect(table.getAttribute("aria-checked")).toBe("true");

    table.focus();
    fireEvent.keyDown(table, { code: "ArrowRight", key: "ArrowRight" });

    expect(kanban.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(kanban);
  });

  test("exposes stable card-grid loading geometry through the Facade", () => {
    render(
      <MyoxusUIProvider>
        <SelectionCardSkeletonGrid count={3} />
      </MyoxusUIProvider>,
    );
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="radio-selection-card-skeleton-grid"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelectorAll(
        '[data-myoxus-ui-role="radio-selection-card-skeleton"]',
      ),
    ).toHaveLength(3);
  });
});
