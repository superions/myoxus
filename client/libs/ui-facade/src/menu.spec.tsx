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
import type { HTMLAttributes, ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ColorSwatch,
  ConfirmModal,
  ContextMenu,
  FileMenuItem,
  IconButton,
  Menu,
  MenuItem,
  MenuOptionButton,
  MenuOptionGroup,
  MenuPanel,
  MenuScrollableSection,
  MenuSection,
  MenuSectionLabel,
  MenuSeparator,
  MenuSub,
  MenuSummaryRow,
  MenuTrigger,
  Modal,
  SelectionIndicator,
  SplitMenuButton,
  SwatchSelectTrigger,
  Tooltip,
} from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider env="test">{ui}</MyoxusUIProvider>);
}

describe("facade menu primitives", () => {
  afterEach(() => {
    cleanup();
  });

  test("a dialog menu stays in its owning modal and can select without dismissing the dialog", async () => {
    const select = vi.fn();
    const close = vi.fn();
    renderWithProvider(
      <Modal open title="Recording settings" onOpenChange={close}>
        <Menu
          items={
            <>
              <MenuOptionButton>Keep title</MenuOptionButton>
              <MenuItem onSelect={select}>{"Today's journal"}</MenuItem>
            </>
          }
        >
          <MenuTrigger>Saving mode</MenuTrigger>
        </Menu>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Saving mode" }));
    const item = await screen.findByRole("menuitem", {
      name: "Today's journal",
      hidden: true,
    });
    expect(screen.getByRole("dialog").contains(item)).toBe(true);
    fireEvent.keyDown(screen.getByRole("button", { name: "Keep title" }), {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Saving mode" }));
    const reopenedItem = await screen.findByRole("menuitem", {
      name: "Today's journal",
    });
    fireEvent.click(reopenedItem);
    expect(select).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  test("renders dropdown menus through the Myoxus facade instead of old component barrels", async () => {
    const handleSelect = vi.fn();

    renderWithProvider(
      <Menu
        title="Actions"
        items={
          <>
            <MenuItem
              lang="de"
              selected
              title="Primäre Aktion"
              onSelect={handleSelect}
            >
              Primary action
            </MenuItem>
            <MenuSeparator />
            <MenuSub items={<MenuItem>Nested action</MenuItem>}>
              More actions
            </MenuSub>
          </>
        }
      >
        <MenuTrigger>Open actions</MenuTrigger>
      </Menu>,
    );

    const trigger = screen.getByRole("button", { name: /open actions/i });
    fireEvent.click(trigger);

    const item = await screen.findByRole("menuitem", {
      name: /primary action/i,
      hidden: true,
    });
    expect(item.dataset.myoxusUiRole).toBe("menu-item");
    expect(item.getAttribute("style")).toContain("--mantine-font-family-nav");
    expect(item.getAttribute("style")).not.toContain(
      "--myoxus-typography-nav-family",
    );
    expect(item.getAttribute("lang")).toBe("de");
    expect(item.getAttribute("title")).toBe("Primäre Aktion");
    expect(screen.getByText("Actions")).not.toBeNull();
    expect(screen.getByRole("separator", { hidden: true })).not.toBeNull();

    fireEvent.click(item);
    expect(handleSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  test("keeps native keyboard focus inside ordinary dropdown menus", async () => {
    const handleMove = vi.fn();
    const user = userEvent.setup();

    renderWithProvider(
      <Menu
        items={
          <>
            <MenuItem>Open</MenuItem>
            <MenuItem>Open beside</MenuItem>
            <MenuItem>Open in new tab</MenuItem>
            <MenuItem>Favourite</MenuItem>
            <Tooltip
              content="Choose a destination folder"
              events={{ focus: true, hover: true, touch: false }}
            >
              <MenuItem onSelect={handleMove}>Move to folder</MenuItem>
            </Tooltip>
          </>
        }
      >
        <MenuTrigger>Database menu</MenuTrigger>
      </Menu>,
    );

    const trigger = screen.getByRole("button", { name: "Database menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "Move to folder" });

    await user.keyboard(
      "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Move to folder" }),
    );
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Choose a destination folder",
    );
    await user.keyboard("{Enter}");

    expect(handleMove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("gives custom menu targets valid button semantics", () => {
    const CustomTrigger = (props: HTMLAttributes<HTMLDivElement>) => (
      <div {...props} data-testid="custom-menu-trigger" />
    );

    renderWithProvider(
      <Menu items={<MenuItem>Action</MenuItem>}>
        <CustomTrigger>Open custom menu</CustomTrigger>
      </Menu>,
    );

    const trigger = screen.getByTestId("custom-menu-trigger");
    expect(trigger.getAttribute("role")).toBe("button");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("uses an icon menu target tooltip as its accessible name", () => {
    renderWithProvider(
      <Menu items={<MenuItem>Action</MenuItem>}>
        <IconButton tooltip="More actions" />
      </Menu>,
    );

    expect(screen.getByRole("button", { name: "More actions" })).not.toBeNull();
  });

  test("opens context menus on right-click and closes after item selection", () => {
    const handleSelect = vi.fn();

    renderWithProvider(
      <ContextMenu
        asChild
        items={<MenuItem onSelect={handleSelect}>Open document</MenuItem>}
      >
        <div>Document row</div>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Document row"), {
      clientX: 32,
      clientY: 48,
    });

    const item = screen.getByRole("menuitem", { name: /open document/i });
    expect(
      item.closest("[data-myoxus-ui-role='context-menu-content']"),
    ).not.toBeNull();
    expect(item.dataset.myoxusUiRole).toBe("menu-item");

    fireEvent.click(item);
    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: /open document/i })).toBe(
      null,
    );
  });

  test("assigns a semantic Myoxus button role to non-native menu triggers", async () => {
    renderWithProvider(
      <Menu items={<MenuItem>Use template</MenuItem>}>
        <span>
          Template
          <input aria-label="Nested control" />
        </span>
      </Menu>,
    );

    const trigger = screen.getByRole("button", { name: "Template" });
    expect(trigger.dataset.myoxusUiRole).toBe("button:inline-menu-trigger");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Nested control" }), {
      key: "Enter",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(
      await screen.findByRole("menuitem", {
        hidden: true,
        name: /use template/i,
      }),
    ).not.toBeNull();
    fireEvent.keyDown(trigger, { key: " " });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("opens menus from swatch select triggers", async () => {
    renderWithProvider(
      <Menu items={<MenuItem>Facade QA Tag</MenuItem>}>
        <SwatchSelectTrigger
          aria-label="Tags: Facade QA Tag"
          color="#2f80ed"
          label="Facade QA Tag"
        />
      </Menu>,
    );

    const trigger = screen.getByRole("button", {
      name: /tags: facade qa tag/i,
    });
    fireEvent.click(trigger);

    expect(
      await screen.findByRole("menuitem", {
        hidden: true,
        name: /facade qa tag/i,
      }),
    ).not.toBeNull();
  });

  test("uses Mantine unstyled buttons for primitive fallback triggers", async () => {
    renderWithProvider(
      <Menu items={<MenuItem>Use template</MenuItem>}>Template</Menu>,
    );

    const trigger = screen.getByRole("button", { name: "Template" });
    expect(trigger.className).toContain("mantine-UnstyledButton-root");
    expect(trigger.dataset.myoxusUiRole).toBe("button:inline-menu-trigger");

    fireEvent.click(trigger);
    expect(
      await screen.findByRole("menuitem", {
        hidden: true,
        name: /use template/i,
      }),
    ).not.toBeNull();
  });

  test("keeps menu styling in Mantine/facade contracts", () => {
    renderWithProvider(
      <ContextMenu
        asChild
        items={<MenuItem type="danger">Delete document</MenuItem>}
      >
        <div>Document row</div>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Document row"), {
      clientX: 32,
      clientY: 48,
    });

    const item = screen.getByRole("menuitem", { name: /delete document/i });
    const style = item.getAttribute("style") ?? "";
    expect(style).toContain("--mantine-font-family-nav");
    expect(style).not.toContain("--myoxus-typography-nav-family");
  });

  test("renders display-menu structure through facade roles instead of product CSS classes", () => {
    renderWithProvider(
      <MenuPanel panelWidth="display" data-testid="display-menu-panel">
        <MenuSection>
          <MenuSectionLabel>Display properties</MenuSectionLabel>
          <MenuOptionGroup>
            <MenuOptionButton active>Tags</MenuOptionButton>
            <MenuOptionButton>Updated</MenuOptionButton>
          </MenuOptionGroup>
        </MenuSection>
        <MenuSummaryRow label="Grouping" value="Created" />
      </MenuPanel>,
    );

    const panel = screen.getByTestId("display-menu-panel");
    expect(panel.dataset.myoxusUiRole).toBe("menu-panel");
    expect(panel.getAttribute("style")).toContain(
      "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
    );
    expect(screen.getByText("Display properties").dataset.myoxusUiRole).toBe(
      "menu-section-label",
    );
    expect(
      screen.getByText("Grouping").parentElement?.dataset.myoxusUiRole,
    ).toBe("menu-summary-row");

    const activeOption = screen.getByRole("button", { name: "Tags" });
    const inactiveOption = screen.getByRole("button", { name: "Updated" });
    expect(activeOption.getAttribute("aria-pressed")).toBe("true");
    expect(activeOption.style.background).toContain("--myoxus-hover-color");
    expect(activeOption.getAttribute("style")).not.toContain(
      "--myoxus-typography-nav-family",
    );
    expect(inactiveOption.dataset.active).toBe("false");
    expect(inactiveOption.style.background).toBe("transparent");
  });

  test("distinguishes active keyboard focus from checked menu selection", () => {
    renderWithProvider(
      <MenuPanel data-testid="member-selector-panel">
        <MenuItem active data-testid="active-member">
          Alice
        </MenuItem>
        <MenuItem checked data-testid="checked-member">
          Bob
        </MenuItem>
      </MenuPanel>,
    );

    const active = screen.getByTestId("active-member");
    const checked = screen.getByTestId("checked-member");
    expect(active.dataset.active).toBe("true");
    expect(active.dataset.checked).toBeUndefined();
    expect(active.getAttribute("style")).toContain("--myoxus-hover-color");
    expect(checked.dataset.checked).toBe("true");
    expect(checked.dataset.active).toBeUndefined();
  });

  test("owns large submenu panels without product width CSS", () => {
    renderWithProvider(
      <MenuPanel
        panelPadding="comfortable"
        panelWidth="large"
        data-testid="large-menu-panel"
      >
        Share
      </MenuPanel>,
    );

    const panel = screen.getByTestId("large-menu-panel");
    expect(panel.dataset.myoxusUiRole).toBe("menu-panel");
    expect(panel.getAttribute("style")).toContain("max-width: calc(100vw");
  });

  test("projects shared panel widths onto dropdown and submenu content", async () => {
    renderWithProvider(
      <Menu
        contentOptions={{
          panelPadding: "comfortable",
          panelWidth: "large",
          "data-testid": "large-menu-dropdown",
        }}
        items={
          <MenuSub
            subContentOptions={{
              panelPadding: "comfortable",
              panelWidth: "large",
              "data-testid": "large-submenu-dropdown",
            }}
            items={<MenuItem>Nested action</MenuItem>}
          >
            Share submenu
          </MenuSub>
        }
      >
        <MenuTrigger>Open share actions</MenuTrigger>
      </Menu>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /open share actions/i }),
    );

    const dropdown = await screen.findByTestId("large-menu-dropdown");
    expect(dropdown.getAttribute("style")).toContain("max-width: calc(100vw");

    fireEvent.mouseEnter(
      screen.getByRole("menuitem", { name: /share submenu/i }),
    );

    const submenu = await screen.findByTestId("large-submenu-dropdown");
    expect(submenu.getAttribute("style")).toContain("max-width: calc(100vw");
  });

  test("lets a rich submenu owner close its controlled panel after commit", async () => {
    const view = renderWithProvider(
      <Menu
        rootOptions={{ open: true }}
        items={
          <MenuSub
            items={<input aria-label="Link value" />}
            subOptions={{ open: true }}
          >
            Link
          </MenuSub>
        }
      >
        <MenuTrigger>More actions</MenuTrigger>
      </Menu>,
    );

    expect(
      await screen.findByRole("textbox", { name: "Link value" }),
    ).not.toBeNull();

    view.rerender(
      <MyoxusUIProvider>
        <Menu
          rootOptions={{ open: true }}
          items={
            <MenuSub
              items={<input aria-label="Link value" />}
              subOptions={{ open: false }}
            >
              Link
            </MenuSub>
          }
        >
          <MenuTrigger>More actions</MenuTrigger>
        </Menu>
      </MyoxusUIProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Link value" })).toBeNull();
    });
  });

  test("keeps non-closing submenu choices open for consecutive selection", async () => {
    const handleSelect = vi.fn();
    renderWithProvider(
      <Menu
        items={
          <MenuSub
            items={
              <>
                <MenuItem
                  closeMenuOnClick={false}
                  onSelect={() => handleSelect("outline")}
                >
                  Outline
                </MenuItem>
                <MenuItem
                  closeMenuOnClick={false}
                  onSelect={() => handleSelect("comments")}
                >
                  Comments
                </MenuItem>
              </>
            }
          >
            Tools
          </MenuSub>
        }
      >
        <MenuTrigger>Open tools</MenuTrigger>
      </Menu>,
    );

    const rootTrigger = screen.getByRole("button", { name: "Open tools" });
    fireEvent.click(rootTrigger);
    fireEvent.mouseEnter(
      await screen.findByRole("menuitem", { name: "Tools" }),
    );
    const outlineItem = await screen.findByRole("menuitem", {
      name: "Outline",
    });
    const rootDropdown = outlineItem.closest<HTMLElement>(
      '[data-myoxus-ui-role="menu-content"]',
    );
    expect(rootDropdown).not.toBeNull();
    expect(rootDropdown?.style.maxHeight).toBe("");
    expect(rootDropdown?.style.overflowY).toBe("");

    // A real pointer click dispatches mousedown before click. The nested
    // Mantine menu remains inside the root dropdown, so no outside interaction
    // closes the root before closeMenuOnClick can preserve it.
    fireEvent.mouseDown(outlineItem);
    fireEvent.click(outlineItem);
    outlineItem.focus();
    fireEvent.keyDown(outlineItem, { key: "ArrowDown" });

    const commentsItem = await screen.findByRole("menuitem", {
      name: "Comments",
    });
    expect(document.activeElement).toBe(commentsItem);
    fireEvent.mouseDown(commentsItem);
    fireEvent.click(commentsItem);

    expect(handleSelect.mock.calls).toEqual([["outline"], ["comments"]]);
    expect(rootTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menuitem", { name: "Outline" })).not.toBeNull();
  });

  test("places and directs submenu disclosure on the preferred opening side", async () => {
    renderWithProvider(
      <Menu
        items={
          <MenuSub
            subContentOptions={{ side: "left" }}
            items={<MenuItem>Calendar</MenuItem>}
          >
            Tools
          </MenuSub>
        }
      >
        <MenuTrigger>Open tools</MenuTrigger>
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    const submenuTrigger = await screen.findByRole("menuitem", {
      name: "Tools",
    });
    const disclosure = submenuTrigger.querySelector<SVGElement>(
      '[data-myoxus-ui-role="menu-sub-disclosure-icon"]',
    );

    expect(disclosure?.dataset.menuSubSide).toBe("left");
    expect(disclosure?.getAttribute("style")).toContain("rotate(180deg)");
    expect(disclosure?.closest('[data-position="left"]')).not.toBeNull();
    expect(
      submenuTrigger.querySelector('[data-position="right"] svg'),
    ).toBeNull();
  });

  test("derives every closed submenu disclosure from the parent menu alignment", async () => {
    renderWithProvider(
      <Menu
        contentOptions={{ side: "bottom", align: "end" }}
        items={
          <>
            <MenuSub items={<MenuItem>Outline</MenuItem>}>Tools</MenuSub>
            <MenuSub items={<MenuItem>Markdown</MenuItem>}>Import</MenuSub>
            <MenuSub items={<MenuItem>PDF</MenuItem>}>Export</MenuSub>
            <MenuSub
              subContentOptions={{ side: "right" }}
              items={<MenuItem>Explicit action</MenuItem>}
            >
              Explicit right
            </MenuSub>
          </>
        }
      >
        <MenuTrigger>Open document menu</MenuTrigger>
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open document menu" }));

    for (const name of ["Tools", "Import", "Export"]) {
      const trigger = await screen.findByRole("menuitem", { name });
      const disclosure = trigger.querySelector<SVGElement>(
        '[data-myoxus-ui-role="menu-sub-disclosure-icon"]',
      );
      expect(disclosure?.dataset.menuSubSide).toBe("left");
      expect(disclosure?.closest('[data-position="left"]')).not.toBeNull();
      expect(trigger.querySelector('[data-position="right"] svg')).toBeNull();
    }

    const explicitTrigger = await screen.findByRole("menuitem", {
      name: "Explicit right",
    });
    const explicitDisclosure = explicitTrigger.querySelector<SVGElement>(
      '[data-myoxus-ui-role="menu-sub-disclosure-icon"]',
    );
    expect(explicitDisclosure?.dataset.menuSubSide).toBe("right");
    expect(
      explicitDisclosure?.closest('[data-position="right"]'),
    ).not.toBeNull();
  });

  test("uses Mantine FileButton for file-backed menu actions without visible native input chrome", async () => {
    const handleFile = vi.fn();

    renderWithProvider(
      <Menu
        items={
          <FileMenuItem
            accept=".ics,text/calendar"
            inputUiRole="journal-footer-file-input"
            onFile={handleFile}
          >
            Import calendar
          </FileMenuItem>
        }
      >
        <MenuTrigger>Open actions</MenuTrigger>
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open actions/i }));

    const menuItem = await screen.findByRole("menuitem", {
      hidden: true,
      name: /import calendar/i,
    });
    expect(menuItem.dataset.myoxusUiRole).toBe("menu-item");

    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][data-myoxus-ui-role="journal-footer-file-input"]',
    );
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-hidden")).toBe("true");
    expect(input?.tabIndex).toBe(-1);

    const file = new File(["BEGIN:VCALENDAR\nEND:VCALENDAR"], "calendar.ics", {
      type: "text/calendar",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    fireEvent.change(input!);

    expect(handleFile).toHaveBeenCalledWith(file);
  });

  test("renders split menu buttons through facade-owned layout", async () => {
    const onClick = vi.fn();

    renderWithProvider(
      <SplitMenuButton
        label="Copy Link"
        menuRootOptions={{ defaultOpen: false }}
        menuItems={<MenuItem>Copy page link</MenuItem>}
        actionTestId="copy-link-action"
        menuTestId="copy-link-menu-trigger"
        onClick={onClick}
        shortcut="Ctrl + Shift + C"
      />,
    );

    const label = screen.getByText("Copy Link");
    const root = label.closest("[data-myoxus-ui-role='split-menu-button']");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("style")).toContain("width: 100%");
    const action = screen.getByTestId("copy-link-action");
    expect(action.dataset.myoxusUiRole).toBe("split-menu-button-action");

    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);

    const trigger = screen.getByTestId("copy-link-menu-trigger");
    expect(trigger.dataset.myoxusUiRole).toBe("split-menu-button-trigger");
    expect(trigger.getAttribute("style")).toContain("--button-bg");

    fireEvent.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: /copy page link/i }),
    ).not.toBeNull();
  });

  test("allows split menu buttons to opt out of fluid toolbar width", () => {
    renderWithProvider(
      <SplitMenuButton
        fluid={false}
        label="New doc"
        menuItems={<MenuItem>New page</MenuItem>}
        menuTestId="new-page-menu-trigger"
        onClick={vi.fn()}
        variant="secondary"
      />,
    );

    const root = screen
      .getByText("New doc")
      .closest("[data-myoxus-ui-role='split-menu-button']") as HTMLElement;

    expect(root.style.width).toBe("max-content");
    expect(root.style.flexGrow).toBe("0");
    expect(root.style.flexShrink).toBe("0");
    expect(root.style.flexBasis).toBe("auto");
  });

  test("confirm modal closes after a successful async confirm action", async () => {
    const handleConfirm = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    renderWithProvider(
      <ConfirmModal
        open
        title="Delete document?"
        confirmText="Delete"
        onConfirm={handleConfirm}
        onOpenChange={handleOpenChange}
      />,
    );

    fireEvent.click(screen.getByTestId("confirm-modal-confirm"));

    await waitFor(() => {
      expect(handleConfirm).toHaveBeenCalledTimes(1);
      expect(handleOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("owns bounded option lists and selection indicators without product menu CSS", async () => {
    renderWithProvider(
      <Menu
        items={
          <MenuScrollableSection data-testid="color-section">
            <MenuItem
              checked
              prefixIcon={
                <ColorSwatch
                  color="var(--myoxus-tag-blue)"
                  shape="circle"
                  size="var(--mantine-spacing-lg)"
                />
              }
            >
              Blue
            </MenuItem>
          </MenuScrollableSection>
        }
      >
        <MenuTrigger>Colors</MenuTrigger>
      </Menu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Colors" }));

    const section = await screen.findByTestId("color-section");
    expect(section.dataset.myoxusUiRole).toBe("menu-scrollable-section");
    expect(section.getAttribute("style")).toContain(
      "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 5\n  )",
    );
    const content = section.querySelector(
      '[data-myoxus-ui-role="menu-scrollable-section-content"]',
    ) as HTMLElement;
    expect(content.style.width).toBe("100%");
    expect(
      screen.getByRole("menuitem", { hidden: true, name: "Blue" }).dataset
        .checked,
    ).toBe("true");

    cleanup();
    renderWithProvider(
      <>
        <SelectionIndicator selected data-testid="selected" />
        <SelectionIndicator selected={false} data-testid="not-selected" />
      </>,
    );

    expect(screen.getByTestId("selected").dataset.myoxusUiRole).toBe(
      "selection-indicator",
    );
    expect(screen.getByTestId("selected").dataset.selected).toBe("true");
    expect(screen.getByTestId("selected").getAttribute("style")).toContain(
      "--myoxus-primary-color",
    );
    expect(screen.getByTestId("not-selected").dataset.selected).toBe("false");
    expect(screen.getByTestId("not-selected").getAttribute("style")).toContain(
      "opacity: 0",
    );
  });
});
