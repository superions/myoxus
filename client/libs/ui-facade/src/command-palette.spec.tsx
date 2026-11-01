// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CommandPaletteGroup,
  CommandPaletteGroupHeading,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteItemBody,
  CommandPaletteItemIcon,
  CommandPaletteItemTitle,
  CommandPaletteList,
  CommandPaletteModal,
  CommandPaletteRoot,
  CommandPaletteSearchRow,
  CommandPaletteShortcut,
  CommandPaletteShortcutKey,
} from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("CommandPalette facade", () => {
  test("renders a Mantine-backed command dialog with combobox/listbox semantics", () => {
    const onOpenChange = vi.fn();
    const onChange = vi.fn();
    const onCommit = vi.fn();

    render(
      <MyoxusUIProvider>
        <CommandPaletteModal open onOpenChange={onOpenChange}>
          <CommandPaletteRoot
            role="combobox"
            aria-expanded="true"
            aria-controls="commands"
            data-testid="palette"
          >
            <CommandPaletteSearchRow>
              <CommandPaletteInput
                value="mov"
                placeholder="Search"
                onChange={onChange}
                loading
              />
            </CommandPaletteSearchRow>
            <CommandPaletteList id="commands" role="listbox">
              <CommandPaletteGroup role="group" aria-label="Commands">
                <CommandPaletteGroupHeading>
                  Commands
                </CommandPaletteGroupHeading>
                <CommandPaletteItem
                  id="delete"
                  selected
                  tone="danger"
                  onClick={onCommit}
                  data-testid="delete"
                >
                  <CommandPaletteItemIcon>D</CommandPaletteItemIcon>
                  <CommandPaletteItemBody>
                    <CommandPaletteItemTitle>Delete</CommandPaletteItemTitle>
                  </CommandPaletteItemBody>
                  <CommandPaletteShortcut>
                    <CommandPaletteShortcutKey>Ctrl</CommandPaletteShortcutKey>
                    <CommandPaletteShortcutKey>K</CommandPaletteShortcutKey>
                  </CommandPaletteShortcut>
                </CommandPaletteItem>
              </CommandPaletteGroup>
            </CommandPaletteList>
          </CommandPaletteRoot>
        </CommandPaletteModal>
      </MyoxusUIProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).not.toBeNull();
    expect(screen.getByTestId("palette").dataset.myoxusUiRole).toBe(
      "command-palette",
    );
    expect(screen.getByRole("combobox")).not.toBeNull();
    expect(screen.getByRole("listbox")).not.toBeNull();
    expect(screen.getByRole("group", { name: "Commands" })).not.toBeNull();

    const option = screen.getByRole("option", { name: /Delete/ });
    expect(option.dataset.myoxusUiRole).toBe("command-palette-item:danger");
    expect(option.dataset.selected).toBe("true");
    expect(option.dataset.tone).toBe("danger");

    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "move" },
    });
    expect(onChange).toHaveBeenCalledWith("move");

    fireEvent.click(option);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test("keeps disabled options inert inside the facade", () => {
    const onClick = vi.fn();

    render(
      <MyoxusUIProvider>
        <CommandPaletteItem disabled onClick={onClick}>
          Disabled
        </CommandPaletteItem>
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByRole("option"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
