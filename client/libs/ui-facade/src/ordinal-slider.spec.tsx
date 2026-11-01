// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { OrdinalSlider } from "./ordinal-slider";
import { MyoxusUIProvider } from "./provider";

const options = [
  { value: 0, label: "Lowest priority" },
  { value: 1, label: "Low priority" },
  { value: 2, label: "Normal priority" },
  { value: 3, label: "High priority" },
  { value: 4, label: "Critical priority" },
];

describe("facade OrdinalSlider", () => {
  afterEach(() => cleanup());

  test("uses native marked keyboard interaction and commits once per step", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(
      <MyoxusUIProvider>
        <OrdinalSlider
          ariaLabel="Priority"
          options={options}
          value={2}
          onChange={onChange}
          onChangeEnd={onChangeEnd}
        />
      </MyoxusUIProvider>,
    );

    const slider = screen.getByRole("slider", { name: "Priority" });
    expect(slider.getAttribute("aria-valuetext")).toBe("Normal priority");
    expect(screen.getByText("Lowest priority")).not.toBeNull();
    expect(screen.getByText("Normal priority")).not.toBeNull();
    expect(screen.getByText("Critical priority")).not.toBeNull();
    expect(screen.queryByText("Low priority")).toBeNull();
    expect(screen.queryByText("High priority")).toBeNull();
    fireEvent.keyDown(slider, { key: "End" });
    expect(onChange).toHaveBeenCalledWith(4);
    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(4);
  });

  test("renders readonly ordinal values without a false edit affordance", () => {
    render(
      <MyoxusUIProvider>
        <OrdinalSlider
          ariaLabel="Readonly priority"
          options={options}
          readonly
          value={4}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Critical priority")).not.toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
