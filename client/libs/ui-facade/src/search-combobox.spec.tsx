/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";

import { Modal, SearchCombobox, type SearchComboboxOption } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

const options: SearchComboboxOption[] = [
  {
    id: "opt-0",
    value: "entity-0",
    title: "Alpha",
    meta: "Root > Alpha",
    code: "alpha",
    active: true,
    selected: true,
    testId: "option-alpha",
  },
];

describe("SearchCombobox", () => {
  test("dismisses an open dropdown before allowing Escape to close its native modal", () => {
    const onOwnerChange = vi.fn();
    function Picker() {
      const [open, setOpen] = useState(true);
      return (
        <Modal open title="Picker owner" onOpenChange={onOwnerChange}>
          <SearchCombobox
            value="a"
            placeholder="Search"
            isOpen={open}
            listboxId="list"
            options={options}
            state={{ kind: "options" }}
            onInputChange={vi.fn()}
            onInputFocus={vi.fn()}
            onOptionCommit={vi.fn()}
            onInputKeyDown={(event) => {
              if (event.key === "Escape" && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
        </Modal>
      );
    }
    render(
      <MyoxusUIProvider>
        <Picker />
      </MyoxusUIProvider>,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOwnerChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOwnerChange).toHaveBeenCalledExactlyOnceWith(false);
  });
  test("renders combobox semantics, options and state slots from the facade", () => {
    const onInputChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <SearchCombobox
          value="a"
          placeholder="Search"
          label="Organization unit"
          isOpen
          listboxId="list"
          activeDescendant="opt-0"
          state={{ kind: "options" }}
          options={options}
          onInputChange={onInputChange}
          onInputFocus={vi.fn()}
          onInputKeyDown={vi.fn()}
          onOptionCommit={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    const input = screen.getByRole("combobox");
    expect(screen.getByLabelText("Organization unit")).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("opt-0");
    expect(screen.getByRole("listbox")).toBeDefined();
    expect(screen.getByTestId("option-alpha").textContent).toContain("Alpha");

    fireEvent.change(input, { target: { value: "al" } });
    expect(onInputChange).toHaveBeenCalledWith("al");
  });

  test("commits options and closes on outside click", () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(
      <MyoxusUIProvider>
        <>
          <SearchCombobox
            value="a"
            placeholder="Search"
            isOpen
            listboxId="list"
            state={{ kind: "options" }}
            options={options}
            onInputChange={vi.fn()}
            onInputFocus={vi.fn()}
            onInputKeyDown={vi.fn()}
            onOptionCommit={onCommit}
            onClose={onClose}
          />
          <button type="button">outside</button>
        </>
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByTestId("option-alpha"));
    expect(onCommit).toHaveBeenCalledWith(options[0]);

    fireEvent.mouseDown(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("renders loading and error states without product-local markup", () => {
    const { rerender } = render(
      <MyoxusUIProvider>
        <SearchCombobox
          value="a"
          placeholder="Search"
          isOpen
          listboxId="list"
          state={{ kind: "loading", label: "Loading", testId: "loading" }}
          options={[]}
          onInputChange={vi.fn()}
          onInputFocus={vi.fn()}
          onInputKeyDown={vi.fn()}
          onOptionCommit={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("loading").textContent).toBe("Loading");

    rerender(
      <MyoxusUIProvider>
        <SearchCombobox
          value="a"
          placeholder="Search"
          isOpen
          listboxId="list"
          state={{ kind: "error", label: "Error", testId: "error" }}
          options={[]}
          onInputChange={vi.fn()}
          onInputFocus={vi.fn()}
          onInputKeyDown={vi.fn()}
          onOptionCommit={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("error").dataset.state).toBe("error");
  });

  test("keeps embedded options in their enclosing picker and commits the selection", () => {
    const onCommit = vi.fn();
    const grouped = [
      { ...options[0], group: "Documents" },
      {
        id: "disabled-result",
        value: "disabled-result",
        title: "Unavailable",
        group: "Documents",
        disabled: true,
      },
    ];
    render(
      <MyoxusUIProvider>
        <div data-testid="picker-owner">
          <SearchCombobox
            embedded
            value="a"
            placeholder="Search"
            isOpen
            listboxId="list"
            options={grouped}
            state={{ kind: "options" }}
            onInputChange={vi.fn()}
            onInputFocus={vi.fn()}
            onInputKeyDown={vi.fn()}
            onOptionCommit={onCommit}
          />
        </div>
      </MyoxusUIProvider>,
    );
    const option = screen.getByTestId("option-alpha");
    expect(screen.getByTestId("picker-owner").contains(option)).toBe(true);
    expect(screen.getByText("Documents")).not.toBeNull();
    fireEvent.click(option);
    expect(onCommit).toHaveBeenCalledWith(grouped[0]);
    fireEvent.click(screen.getByRole("option", { name: "Unavailable" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test("keeps disabled input semantics without local input chrome classes", () => {
    render(
      <MyoxusUIProvider>
        <SearchCombobox
          value="a"
          placeholder="Search"
          disabled
          isOpen={false}
          listboxId="list"
          state={{ kind: "options" }}
          options={options}
          onInputChange={vi.fn()}
          onInputFocus={vi.fn()}
          onInputKeyDown={vi.fn()}
          onOptionCommit={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    const input = screen.getByRole("combobox");
    expect(input).toHaveProperty("disabled", true);
    expect(input.className).not.toContain("myoxus-ui-search-combobox__input");
  });
});
