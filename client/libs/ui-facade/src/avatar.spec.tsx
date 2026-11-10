// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Avatar, AvatarStack } from "./index";
import { MyoxusUIProvider } from "./provider";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("facade avatar primitive", () => {
  afterEach(() => cleanup());

  test("renders shared fallback initials through Mantine Avatar semantics", () => {
    renderWithProvider(
      <Avatar
        colorfulFallback
        data-testid="user-avatar"
        kind="user"
        name="Alice Beta"
        size="1em"
        style={{
          height: "var(--mantine-spacing-lg)",
          width: "var(--mantine-spacing-lg)",
        }}
      />,
    );

    const avatar = screen.getByTestId("user-avatar");
    expect(avatar.dataset.avatarKind).toBe("user");
    expect(avatar.dataset.myoxusUiRole).toBe("avatar:user");
    expect(screen.getByText("AB")).not.toBeNull();
    expect(avatar.getAttribute("style")).toContain("letter-spacing: 0");
    expect(avatar.style.fontSize).toBe("");
    expect(avatar.style.getPropertyValue("--avatar-size")).toBe(
      "var(--mantine-spacing-lg)",
    );
    expect(avatar.style.getPropertyValue("--avatar-placeholder-fz")).toContain(
      "--avatar-size",
    );
  });

  test("accepts Mantine size slots so product code does not hard-code avatar pixels", () => {
    renderWithProvider(
      <Avatar
        data-testid="compact-avatar"
        color="var(--myoxus-text-highlight-foreground-green)"
        kind="user"
        name="Alice Beta"
        size="xs"
      />,
    );

    const avatar = screen.getByTestId("compact-avatar");
    expect(avatar.dataset.myoxusUiRole).toBe("avatar:user");
    expect(screen.getByText("A")).not.toBeNull();
    expect(screen.queryByText("AB")).toBeNull();
    const placeholder = screen.getByText("A");
    expect(placeholder.style.background).toBe("");
    expect(placeholder.style.color).toBe("");
    expect(avatar.style.getPropertyValue("--avatar-color")).toContain(
      "--myoxus-text-highlight-foreground-green",
    );
  });

  test("uses image sources instead of falling back to generated initials", () => {
    const { container } = renderWithProvider(
      <Avatar
        data-testid="workspace-avatar"
        image="blob:workspace-avatar"
        kind="workspace"
        name="Design Workspace"
        size={32}
      />,
    );

    const avatar = screen.getByTestId("workspace-avatar");
    expect(avatar.dataset.avatarKind).toBe("workspace");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:workspace-avatar",
    );
    expect(screen.queryByText("DW")).toBe(null);
  });

  test("renders overlapped avatar stacks through Mantine Avatar.Group", () => {
    renderWithProvider(
      <AvatarStack data-testid="member-avatar-stack" kind="workspace">
        <Avatar kind="workspace" name="Alpha Team" size={16} />
        <Avatar kind="workspace" name="Beta Team" size={16} />
      </AvatarStack>,
    );

    const stack = screen.getByTestId("member-avatar-stack");
    expect(stack.dataset.avatarKind).toBe("workspace");
    expect(stack.dataset.myoxusUiRole).toBe("avatar-stack:workspace");
    expect(stack.getAttribute("style")).toContain(
      "--ag-spacing: var(--mantine-spacing-xs)",
    );

    const avatars = stack.querySelectorAll('[data-avatar-kind="workspace"]');
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      expect(avatar.getAttribute("data-within-group")).toBe("true");
      expect(avatar.getAttribute("style")).not.toContain("border: 0");
    }
  });

  test("owns editable avatar hover chrome and stops remove clicks from opening upload parents", () => {
    const handleRemove = vi.fn();
    const handleParentClick = vi.fn();

    const { container } = renderWithProvider(
      <div onClick={handleParentClick}>
        <Avatar
          data-testid="editable-avatar"
          hoverIcon={<span data-testid="avatar-hover-icon">camera</span>}
          name="Editable User"
          onRemove={handleRemove}
          removeButtonProps={{ "data-testid": "remove-avatar" }}
          size={56}
        />
      </div>,
    );

    const shell = container.querySelector(
      '[data-myoxus-ui-role="avatar-edit-shell:user"]',
    );
    expect(shell).not.toBeNull();

    const removeButton = screen.getByTestId("remove-avatar");
    expect(removeButton.style.opacity).toBe("0");

    fireEvent.mouseEnter(shell as Element);
    expect(screen.getByTestId("avatar-hover-icon")).not.toBeNull();
    expect(removeButton.style.opacity).toBe("1");

    fireEvent.click(removeButton);
    expect(handleRemove).toHaveBeenCalledTimes(1);
    expect(handleParentClick).not.toHaveBeenCalled();
  });
});
