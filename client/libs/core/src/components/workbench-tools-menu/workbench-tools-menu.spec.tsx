/**
 * @vitest-environment happy-dom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const view = vi.hoisted(() => ({
  contextSurfaces$: {
    value: [
      { id: "calendar", label: "Calendar" },
      { id: "agenda", label: "Agenda" },
      { id: "activity", label: "Activity" },
    ],
  },
  toolLayout$: {
    value: {
      orderedToolIds: ["calendar", "agenda", "activity"],
      visibleToolIds: ["calendar"],
      collapsedToolIds: [],
    },
  },
  hideTool: vi.fn(),
  showTool: vi.fn(),
}));
const chat = vi.hoisted(() => ({
  enabled: false,
  workbench: { open: vi.fn(), closeContextPanel: vi.fn() },
}));

vi.mock("@myoxus/core/components/hooks/myoxus/use-enable-ai", () => ({
  useEnableAI: () => chat.enabled,
}));
vi.mock("@myoxus/core/modules/workbench/services/workbench", () => ({
  WorkbenchService: class WorkbenchService {},
}));

vi.mock("@myoxus/core/modules/workbench/services/view", () => ({
  ViewService: class ViewService {},
}));

vi.mock("@myoxus/infra", () => ({
  useLiveData: (value: { value: unknown }) => value.value,
  useService: () => ({ view, workbench: chat.workbench }),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => () =>
          key === "com.myoxus.workbench.contextPanel.title"
            ? "Tools"
            : "Open menu",
      },
    ),
}));

vi.mock("@myoxus/ui-facade", () => ({
  MenuSeparator: () => <hr />,
  HeaderMenuButton: ({
    ariaLabel,
    items,
    "data-testid": testId,
  }: {
    ariaLabel: string;
    items: ReactNode;
    "data-testid"?: string;
  }) => (
    <div>
      <button type="button" aria-label={ariaLabel} data-testid={testId} />
      {items}
    </div>
  ),
  MenuSub: ({ children, items }: { children: ReactNode; items: ReactNode }) => (
    <section>
      <span>{children}</span>
      {items}
    </section>
  ),
  MenuItem: ({
    checked,
    children,
    closeMenuOnClick,
    onSelect,
    "data-testid": testId,
  }: {
    checked?: boolean;
    children: ReactNode;
    closeMenuOnClick?: boolean;
    onSelect?: () => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-close-menu-on-click={String(closeMenuOnClick)}
      data-testid={testId}
      onClick={onSelect}
    >
      {children}
    </button>
  ),
}));

import { WorkbenchToolsHeaderMenuButton, WorkbenchToolsMenuSub } from ".";

afterEach(() => {
  cleanup();
  view.contextSurfaces$.value = [
    { id: "calendar", label: "Calendar" },
    { id: "agenda", label: "Agenda" },
    { id: "activity", label: "Activity" },
  ];
  view.toolLayout$.value.visibleToolIds = ["calendar"];
  view.hideTool.mockClear();
  view.showTool.mockClear();
  chat.enabled = false;
  chat.workbench.open.mockClear();
  chat.workbench.closeContextPanel.mockClear();
});

describe("Workbench tools menu", () => {
  test("offers full chat only through the shared AI gate, including routes without document tools", () => {
    view.contextSurfaces$.value = [];
    const rendered = render(<WorkbenchToolsHeaderMenuButton />);
    expect(screen.queryByTestId("workbench-open-workspace-chat")).toBeNull();

    chat.enabled = true;
    rendered.rerender(<WorkbenchToolsHeaderMenuButton />);
    fireEvent.click(screen.getByTestId("workbench-open-workspace-chat"));
    expect(chat.workbench.open).toHaveBeenCalledWith("/chat");
    expect(chat.workbench.closeContextPanel).toHaveBeenCalledOnce();
  });
  test("toggles the registered tool capabilities through the central view", () => {
    render(<WorkbenchToolsMenuSub />);

    expect(screen.getByText("Tools")).toBeTruthy();
    expect(
      screen
        .getByTestId("workbench-tool-menu-calendar")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("workbench-tool-menu-activity")
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("workbench-tool-menu-activity")
        .getAttribute("data-close-menu-on-click"),
    ).toBe("false");

    fireEvent.click(screen.getByTestId("workbench-tool-menu-calendar"));
    fireEvent.click(screen.getByTestId("workbench-tool-menu-activity"));

    expect(view.hideTool).toHaveBeenCalledWith("calendar");
    expect(view.showTool).toHaveBeenCalledWith("activity");
  });

  test("keeps the header recovery trigger when all registered tools are hidden", () => {
    view.toolLayout$.value.visibleToolIds = [];
    const rendered = render(<WorkbenchToolsHeaderMenuButton />);

    expect(screen.getByTestId("header-dropDownButton")).toBeTruthy();
    expect(
      screen
        .getByTestId("workbench-tool-menu-calendar")
        .getAttribute("aria-checked"),
    ).toBe("false");

    view.contextSurfaces$.value = [];
    rendered.rerender(<WorkbenchToolsHeaderMenuButton />);
    expect(screen.queryByTestId("header-dropDownButton")).toBeNull();
  });
});
