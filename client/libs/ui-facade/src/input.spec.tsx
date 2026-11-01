// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ColorInput,
  FormSelect,
  Input,
  MultiSelect,
  MyoxusSelect,
  PasswordInput,
  TagsInput,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

test("read-only native tags retain values without removal controls", () => {
  const onChange = vi.fn();
  render(
    <MyoxusUIProvider>
      <TagsInput
        label="Hosts"
        value={["one.example"]}
        readOnly
        onChange={onChange}
      />
    </MyoxusUIProvider>,
  );
  expect(
    (screen.getByRole("combobox", { name: "Hosts" }) as HTMLInputElement)
      .readOnly,
  ).toBe(true);
  expect(screen.getByText("one.example").textContent).toBe("one.example");
  expect(screen.queryByRole("button")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

function ControlledOptionalColor({
  onChange,
  fixOnBlur,
}: {
  readonly onChange: (value: string) => void;
  readonly fixOnBlur?: boolean;
}) {
  const [value, setValue] = useState("#112233");
  return (
    <>
      <ColorInput
        allowEmpty
        fixOnBlur={fixOnBlur}
        label="Optional color"
        onChange={(nextValue) => {
          setValue(nextValue);
          onChange(nextValue);
        }}
        value={value}
      />
      <output aria-label="Current optional color">{value || "empty"}</output>
    </>
  );
}

describe("Facade Input", () => {
  test("owns technical monospace input styling through Mantine theme variables", () => {
    render(
      <MyoxusUIProvider>
        <Input label="Slug" mono />
      </MyoxusUIProvider>,
    );

    const input = screen.getByLabelText("Slug");
    const root = input.closest("[data-myoxus-ui-role='settings-input']");
    expect(root).not.toBeNull();
    expect(input.getAttribute("style") ?? "").toContain(
      "--mantine-font-family-monospace",
    );
  });

  test("owns borderless row input chrome without product CSS classes", () => {
    render(
      <MyoxusUIProvider>
        <Input label="Search members" noBorder />
      </MyoxusUIProvider>,
    );

    const input = screen.getByLabelText("Search members");
    const style = input.getAttribute("style") ?? "";
    expect(style).toContain("background: transparent");
    expect(style).toContain("border-color: transparent");
    expect(style).toContain("box-shadow: none");
  });

  test("exposes full-width input layout as a facade option", () => {
    render(
      <MyoxusUIProvider>
        <Input label="Search documents" block />
      </MyoxusUIProvider>,
    );

    const root = screen
      .getByLabelText("Search documents")
      .closest("[data-myoxus-ui-role='settings-input']");
    expect(root?.getAttribute("style")).toContain("width: 100%");
  });

  test("preserves native inline validation messages", () => {
    render(
      <MyoxusUIProvider>
        <Input label="Database name" error="Enter a database name" />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Enter a database name").textContent).toBe(
      "Enter a database name",
    );
    expect(
      screen.getByLabelText("Database name").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  test("preserves a controlled empty color through change and blur", () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <ControlledOptionalColor onChange={onChange} />
      </MyoxusUIProvider>,
    );

    const input = screen.getByLabelText("Optional color") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith("");
    expect(input.value).toBe("");
    expect(screen.getByLabelText("Current optional color").textContent).toBe(
      "empty",
    );

    fireEvent.blur(input);

    expect(input.value).toBe("");
    expect(screen.getByLabelText("Current optional color").textContent).toBe(
      "empty",
    );
  });

  test("preserves Source CSS colors and closes the child picker before an enclosing form", () => {
    const parentKeyDown = vi.fn();
    render(
      <MyoxusUIProvider>
        <div onKeyDown={parentKeyDown}>
          <ControlledOptionalColor onChange={() => {}} fixOnBlur={false} />
        </div>
      </MyoxusUIProvider>,
    );
    const input = screen.getByLabelText("Optional color") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "transparent" } });
    fireEvent.blur(input);
    expect(input.value).toBe("transparent");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(input.value).toBe("transparent");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(parentKeyDown).toHaveBeenCalledOnce();
  });

  test("localizes password visibility and updates the accessible action", () => {
    render(
      <MyoxusUIProvider>
        <PasswordInput label="Password" value="secret" />
      </MyoxusUIProvider>,
    );

    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");

    fireEvent.mouseDown(screen.getByRole("button", { name: "Show" }));

    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Hide" })).not.toBeNull();
  });

  test("exposes full-width select layout as a facade option", () => {
    render(
      <MyoxusUIProvider>
        <MyoxusSelect
          label="Workspace"
          data={[{ value: "alpha", label: "Alpha" }]}
          onChange={() => {}}
          block
        />
      </MyoxusUIProvider>,
    );

    const root = screen
      .getByRole("combobox", { name: "Workspace" })
      .closest("[data-myoxus-ui-role='settings-select-root']");
    expect(root?.getAttribute("style")).toContain("max-width: 100%");
  });

  test("exposes an intrinsic select layout for compact controls", () => {
    render(
      <MyoxusUIProvider>
        <MyoxusSelect
          aria-label="Zoom"
          contentSized
          data={[{ value: "100", label: "100%" }]}
          onChange={() => {}}
          value="100"
        />
      </MyoxusUIProvider>,
    );

    const input = screen.getByRole("combobox", { name: "Zoom" });
    const root = input.closest(
      "[data-myoxus-ui-role='settings-select-root']",
    ) as HTMLElement | null;
    expect(root?.style.width).toBe("fit-content");
    expect(root?.style.maxWidth).toBe("100%");
    expect(input.style.fieldSizing).toBe("content");
  });

  test("opens a select and submits the chosen option", async () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <MyoxusSelect
          label="Workspace"
          data={[
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" },
          ]}
          onChange={onChange}
        />
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("option", { name: "Beta" }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  test("exposes a native form select without settings width chrome", () => {
    render(
      <MyoxusUIProvider>
        <FormSelect
          label="Workspace target"
          data={[{ value: "remote", label: "Remote" }]}
          onChange={() => {}}
        />
      </MyoxusUIProvider>,
    );

    const root = screen
      .getByRole("combobox", { name: "Workspace target" })
      .closest("[data-myoxus-ui-role='form-select']");
    expect(root?.getAttribute("style") ?? "").not.toContain("max-width");
  });

  test("exposes one semantic root for multi-select values and actions", () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <MultiSelect
          aria-label="Available locales"
          data={[{ value: "en", label: "English" }]}
          value={["en"]}
          onChange={onChange}
        />
      </MyoxusUIProvider>,
    );

    expect(
      screen
        .getByRole("combobox", { name: "Available locales" })
        .closest('[data-myoxus-ui-role="form-multi-select-root"]'),
    ).not.toBeNull();
    const remove = screen.getByRole("button", { name: "Delete" });
    expect(remove.tabIndex).toBe(0);
    fireEvent.click(remove);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  test("routes clearable select resets through the facade clear contract", () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    const { container } = render(
      <MyoxusUIProvider>
        <MyoxusSelect
          label="Workspace"
          data={[{ value: "alpha", label: "Alpha" }]}
          value="alpha"
          clearable
          onChange={onChange}
          onClear={onClear}
        />
      </MyoxusUIProvider>,
    );

    const clearButton = container.querySelector(
      "button[aria-hidden='true']",
    ) as HTMLButtonElement | null;
    expect(clearButton).not.toBeNull();
    fireEvent.click(clearButton!);

    expect(onClear).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
