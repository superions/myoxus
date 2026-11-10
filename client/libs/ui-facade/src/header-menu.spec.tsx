// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HeaderMenuButton, MenuItem, MenuPanel, Modal } from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(node: React.ReactNode) {
  return render(<MyoxusUIProvider env="test">{node}</MyoxusUIProvider>);
}

afterEach(cleanup);

describe("HeaderMenuButton", () => {
  test("owns the icon trigger, caller attributes, alignment and selection close", async () => {
    const onSelect = vi.fn();
    renderWithProvider(
      <HeaderMenuButton
        ariaLabel="Open page menu"
        data-testid="page-menu"
        data-event-args-control="header"
        items={
          <MenuPanel>
            <MenuItem onSelect={onSelect}>Rename</MenuItem>
          </MenuPanel>
        }
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open page menu" });
    expect(trigger.dataset.myoxusUiRole).toBe("workbench-header-menu");
    expect(trigger.dataset.testid).toBe("page-menu");
    expect(trigger.dataset.eventArgsControl).toBe("header");
    expect(trigger.textContent).toBe("");

    const user = userEvent.setup();
    await user.hover(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Open page menu",
    );
    await user.click(trigger);
    const item = await screen.findByRole("menuitem", { name: "Rename" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    const menu = item.closest('[data-myoxus-ui-role="menu-content"]');
    expect(menu?.getAttribute("data-position")).toBe("bottom-end");
    expect(menu?.getAttribute("style")).toContain(
      "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 5 + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n  )",
    );

    await user.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
    });
  });

  test("keeps native keyboard and outside-dismiss behavior with focus return", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <HeaderMenuButton
        ariaLabel="Open page menu"
        items={
          <MenuPanel>
            <MenuItem>Rename</MenuItem>
            <MenuItem>Copy link</MenuItem>
          </MenuPanel>
        }
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open page menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "Rename" });

    screen.getByRole("menu").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Rename" }),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
    });

    await user.keyboard(" ");
    await screen.findByRole("menuitem", { name: "Copy link" });
    await user.pointer({ target: document.body, keys: "[MouseLeft]" });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  test("supports controlled Modal hand-off and blocks disabled triggers", async () => {
    function Harness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const [menuOpen, setMenuOpen] = useState(false);
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <>
          <HeaderMenuButton
            ref={triggerRef}
            ariaLabel="Open page menu"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={
              <MenuItem
                onSelect={() => {
                  setMenuOpen(false);
                  setModalOpen(true);
                }}
              >
                Edit overview
              </MenuItem>
            }
          />
          <HeaderMenuButton
            ariaLabel="Unavailable menu"
            disabled
            items={<MenuItem>Unavailable</MenuItem>}
          />
          <Modal
            open={modalOpen}
            onOpenChange={setModalOpen}
            returnFocusRef={triggerRef}
            title="Database overview"
          >
            Overview form
          </Modal>
        </>
      );
    }

    renderWithProvider(<Harness />);
    const disabled = screen.getByRole("button", { name: "Unavailable menu" });
    expect(disabled.hasAttribute("disabled")).toBe(true);
    fireEvent.click(disabled);
    expect(screen.queryByRole("menuitem", { name: "Unavailable" })).toBeNull();

    const trigger = screen.getByRole("button", { name: "Open page menu" });
    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit overview" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Database overview" }),
    ).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
