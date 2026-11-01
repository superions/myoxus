import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, expect, test, vi } from "vitest";

import { SizeUnitInput } from "./size-unit-input";

afterEach(cleanup);

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

test("test_size_input_mb_passthrough — allowGb=false, onChange receives raw MB value", () => {
  const onChange = vi.fn();
  renderWithFacade(
    <SizeUnitInput
      value={500}
      onChange={onChange}
      allowGb={false}
      ariaLabel="Storage limit"
    />,
  );

  const input = screen.getByLabelText("Storage limit");
  fireEvent.change(input, { target: { value: "750" } });

  expect(onChange).toHaveBeenCalledWith(750);
});

test("test_size_input_gb_converts_to_mb — selecting GB and entering 10 calls onChange(10240)", () => {
  const onChange = vi.fn();
  const { rerender } = renderWithFacade(
    <SizeUnitInput
      value={null}
      onChange={onChange}
      allowGb={true}
      ariaLabel="Storage limit"
      unitAriaLabel="Storage unit"
    />,
  );

  const trigger = screen.getByRole("combobox", { name: "Storage unit" });
  fireEvent.click(trigger);

  // After opening, "GB" option should be visible in the listbox.
  const gbOption = screen.getByRole("option", { name: "GB" });
  fireEvent.click(gbOption);

  const input = screen.getByLabelText("Storage limit");
  fireEvent.change(input, { target: { value: "10" } });

  expect(onChange).toHaveBeenCalledWith(10240);

  // Changing only the display unit must preserve the unsaved amount in MB.
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "MB" }));
  expect((input as HTMLInputElement).value).toBe("10240");
  expect(onChange).toHaveBeenCalledTimes(1);

  rerender(
    <MyoxusUIProvider>
      <SizeUnitInput
        value={512}
        onChange={onChange}
        allowGb
        ariaLabel="Storage limit"
        unitAriaLabel="Storage unit"
        disabled
      />
    </MyoxusUIProvider>,
  );
  expect((input as HTMLInputElement).value).toBe("512");
  expect((input as HTMLInputElement).disabled).toBe(true);
  expect((trigger as HTMLInputElement).disabled).toBe(true);
});
