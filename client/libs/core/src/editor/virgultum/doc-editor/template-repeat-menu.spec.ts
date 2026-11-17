// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { I18nextProvider, getOrCreateI18n } from "@myoxus/i18n";
import {
  templateRepeatActions,
  type EditorTemplateRepeatPickerControls,
  type SelectionAction,
} from "@virgultum/core/services";
import { SelectionActions } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar/block-actions";
import { renderControl } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import { TableCell } from "../../../../../../../virgultum/content/src/blocks/table/table-cell";
import { afterEach, expect, test, vi } from "vitest";

// Use the same native semantic menu renderer as both productive producers.
vi.hoisted(() => vi.unstubAllGlobals());
vi.unmock("@myoxus/i18n");
afterEach(cleanup);

async function open(
  unit = {
    binding: undefined as unknown,
    texts: ["{{member.name}}"],
    leaf: true,
  },
  build: (
    controls: EditorTemplateRepeatPickerControls,
  ) => SelectionAction[] = templateRepeatActions,
) {
  let writable = true;
  const change = vi.fn((binding) => {
    unit.binding = binding;
  });
  const onClose = vi.fn();
  const actions: SelectionAction[] = [
    {
      id: "repeat",
      label: "Repeat for",
      disabled: false,
      control: {
        type: "menu",
        onClose,
        items: build({ unit: () => unit, canWrite: () => writable, change }),
      },
    },
  ];
  const mounted = render(
    createElement(
      MyoxusUIProvider,
      null,
      createElement(
        I18nextProvider,
        { i18n: getOrCreateI18n() },
        createElement("input", { "aria-label": "Document title" }),
        createElement(SelectionActions, { actions, renderControl }),
      ),
    ),
  );
  screen.getByRole("button", { name: "Repeat for" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Repeat for" }));
  await screen.findByRole("menuitem", { name: "Workspace members" });
  return {
    unit,
    change,
    onClose,
    mounted,
    deny: () => {
      writable = false;
    },
  };
}

test("native repeat submenu authors and removes binding only, without a default write and with cancellation", async () => {
  const f = await open();
  expect(f.change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Workspace members" }));
  expect(f.change).toHaveBeenCalledWith({
    source: "workspace.members",
    alias: "member",
  });
  expect(f.unit.texts).toEqual(["{{member.name}}"]);
  await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce());
  f.mounted.unmount();
  const removal = await open(f.unit);
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove repeat" }));
  expect(removal.change).toHaveBeenCalledWith(undefined);
  expect(removal.unit.texts).toEqual(["{{member.name}}"]);
  await waitFor(() => expect(removal.onClose).toHaveBeenCalledOnce());
  removal.mounted.unmount();
  const cancel = await open();
  fireEvent.keyDown(
    screen.getByRole("menuitem", { name: "Workspace members" }),
    { key: "Escape", bubbles: true },
  );
  await waitFor(() => expect(cancel.onClose).toHaveBeenCalledOnce());
  expect(cancel.change).not.toHaveBeenCalled();
  cancel.mounted.unmount();
  const outside = await open();
  const title = screen.getByRole("textbox", { name: "Document title" });
  title.focus();
  fireEvent.click(title);
  await waitFor(() => expect(outside.onClose).toHaveBeenCalledOnce());
  // Mantine normally returns focus after ten milliseconds; the editor owner
  // must retain the title caret after an outside click, beyond that callback.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(document.activeElement).toBe(title);
  expect(outside.change).not.toHaveBeenCalled();
});

test.each([
  "missing-field",
  "children",
  "changed-text",
  "changed-permission",
  "invalid-binding",
])(
  "native repeat picker respects %s and keeps invalid metadata removable",
  async (kind) => {
    const f = await open({
      binding:
        kind === "invalid-binding"
          ? { source: "unknown", alias: "other" }
          : undefined,
      texts: kind === "missing-field" ? ["Literal text"] : ["{{member.email}}"],
      leaf: kind !== "children",
    });
    if (kind === "changed-text") f.unit.texts = ["No field anymore"];
    if (kind === "changed-permission") act(() => f.deny());
    if (kind === "invalid-binding") {
      expect(screen.getByRole("menu").textContent).toContain(
        "This repeat binding is invalid.",
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove repeat" }));
      expect(f.change).toHaveBeenCalledWith(undefined);
    } else {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Workspace members" }),
      );
      expect(f.change).not.toHaveBeenCalled();
      if (kind === "missing-field")
        expect(screen.getByRole("status").textContent).toContain(
          "{{member.name}}",
        );
      if (kind === "children")
        expect(screen.getByRole("status").textContent).toContain(
          "without nested content",
        );
    }
  },
);

// The previous six cases stubbed canWrite and could not detect the productive
// table producer losing ownership after a cell click or component reuse.
test.each(["selection", "cell"])(
  "table repeat rejects a changed %s through its native submenu",
  async (kind) => {
    const model = { id: "table", children: [] };
    const manager = {
      rows$: { value: [{ rowId: "r", repeat: undefined }] },
      columns$: { value: [{ columnId: "c" }] },
      getCell: () => ({ text: { toString: () => "{{member.name}}" } }),
      canSetRowRepeat: () => true,
      setRowRepeat: vi.fn(() => true),
    };
    const selection = { selected$: { value: { type: "row", rowId: "r" } } };
    const block = {
      isConnected: true,
      model,
      store: { getBlock: () => ({ model }) },
      std: { getOptional: () => ({ isTemplateDocument: () => true }) },
    };
    const cell = {
      readonly: false,
      isConnected: true,
      dataManager: manager,
      selectionController: selection,
      row: { rowId: "r" },
      closest: () => block,
      notifyHeaderRepeatConflict: vi.fn(),
      i18n: undefined,
    };
    await open(undefined, () => {
      const [action] = TableCell.prototype.rowRepeatActions.call(
        cell as unknown as TableCell,
        "r",
      );
      if (action.control?.type !== "menu")
        throw new Error("Missing native repeat submenu");
      return action.control.items;
    });
    if (kind === "selection")
      selection.selected$.value = { type: "row", rowId: "other" };
    else cell.row = { rowId: "other" };
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Workspace members" }),
    );
    expect(manager.setRowRepeat).not.toHaveBeenCalled();
  },
);
