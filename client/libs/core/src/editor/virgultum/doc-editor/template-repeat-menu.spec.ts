// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from "vitest";

import {
  effects,
  Menu,
  type MenuButton,
  type MenuComponent,
  templateRepeatMenuOptions,
} from "@virgultum/components/context-menu";

// The root Lit setup stubs registration for non-rendering tests. This consumer
// needs Happy-DOM's real registry; do not change the global suite's setup.
vi.unstubAllGlobals();
if (!customElements.get("myoxus-menu")) effects();
const openMenus: Menu[] = [];
afterEach(() => openMenus.splice(0).forEach((menu) => menu.close()));

async function open(
  unit = {
    binding: undefined as unknown,
    texts: ["{{member.name}}"],
    leaf: true,
  },
) {
  let writable = true;
  const change = vi.fn((binding) => {
    unit.binding = binding;
  });
  const onClose = vi.fn();
  const menu = new Menu(
    templateRepeatMenuOptions({
      unit: () => unit,
      canWrite: () => writable,
      change,
      onClose,
    }),
  );
  openMenus.push(menu);
  document.body.append(menu.menuElement);
  await (menu.menuElement as MenuComponent).updateComplete;
  const buttons = Array.from(
    menu.menuElement.querySelectorAll<MenuButton>("myoxus-menu-button"),
  );
  await Promise.all(buttons.map((button) => button.updateComplete));
  return {
    menu,
    buttons,
    unit,
    change,
    onClose,
    deny: () => {
      writable = false;
    },
  };
}

test("repeat menu authors and removes binding only, with keyboard cancellation and no Enter default", async () => {
  const f = await open();
  f.buttons[0].onClick();
  expect(f.change).toHaveBeenCalledWith({
    source: "workspace.members",
    alias: "member",
  });
  expect(f.unit.texts).toEqual(["{{member.name}}"]);
  expect(f.onClose).toHaveBeenCalledOnce();
  const removal = await open(f.unit);
  expect(removal.buttons).toHaveLength(2);
  removal.menu.focusTo(removal.buttons[1]);
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  removal.menu.menuElement.querySelector("input")!.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(removal.change).toHaveBeenCalledWith(undefined);
  expect(removal.unit.texts).toEqual(["{{member.name}}"]);
  const cancel = await open();
  cancel.menu.menuElement
    .querySelector("input")!
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  expect(cancel.change).not.toHaveBeenCalled();
  expect(cancel.onClose).toHaveBeenCalledOnce();
});

test.each([
  "missing-field",
  "children",
  "changed-text",
  "changed-permission",
  "invalid-binding",
])(
  "repeat menu respects %s and keeps invalid metadata removable",
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
    if (kind === "changed-permission") f.deny();
    if (kind === "invalid-binding") {
      expect(f.menu.menuElement.textContent).toContain(
        "This repeat binding is invalid.",
      );
      f.buttons[1].onClick();
      expect(f.change).toHaveBeenCalledWith(undefined);
    } else {
      f.buttons[0].onClick();
      f.buttons[0].onPressEnter();
      expect(f.change).not.toHaveBeenCalled();
      if (kind === "missing-field")
        expect(f.menu.menuElement.textContent).toContain("{{member.name}}");
      if (kind === "children")
        expect(f.menu.menuElement.textContent).toContain(
          "without nested content",
        );
    }
  },
);
