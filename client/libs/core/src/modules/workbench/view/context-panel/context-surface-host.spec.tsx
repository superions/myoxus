// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { Framework, FrameworkRoot, LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ViewService } from "../../services/view";
import { ContextSurfaceHost } from "./context-surface-host";

const dndHarness = vi.hoisted(() => ({
  dropTargets: [] as Array<{
    data: { type: string; toolId: string };
    onDrop?: (input: {
      source: { data: { type: string; toolId: string } };
      closestEdge: "top" | "bottom";
    }) => void;
  }>,
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const facade = await importOriginal<typeof import("@myoxus/ui-facade")>();
  return {
    ...facade,
    useDraggable: () => ({
      dragRef: { current: null },
      dragHandleRef: { current: null },
      dragging: false,
    }),
    useDropTarget: (factory: () => (typeof dndHarness.dropTargets)[number]) => {
      dndHarness.dropTargets.push(factory());
      return { dropTargetRef: { current: null }, closestEdge: null };
    },
  };
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "com.myoxus.workbench.tool.remove"
            ? ({ tool }: { tool: string }) => `Remove ${tool}`
            : key === "com.myoxus.keyboardShortcuts.moveUp"
              ? () => "Move up"
              : key === "com.myoxus.keyboardShortcuts.moveDown"
                ? () => "Move down"
                : () => "Move",
      },
    ),
}));

let disposeProvider: (() => void) | undefined;
afterEach(() => {
  cleanup();
  disposeProvider?.();
  disposeProvider = undefined;
  dndHarness.dropTargets.length = 0;
});

describe("ContextSurfaceHost", () => {
  test("shares collapse, hide and keyboard reorder with the visible card stack", async () => {
    const view = {
      id: "view-a",
      contextSurfaces$: new LiveData([
        {
          id: "outline",
          label: "Outline",
          tooltip: "Outline",
          viewFamilies: [],
        },
        {
          id: "activity",
          label: "Activity",
          tooltip: "Activity",
          viewFamilies: [],
        },
      ]),
      toolViewFamily$: new LiveData("document-page"),
      toolLayout$: new LiveData({
        orderedToolIds: ["outline", "activity"],
        visibleToolIds: ["outline", "activity"],
        collapsedToolIds: ["activity"],
      }),
      toolHeaderFocusRequest$: new LiveData(null),
      hideTool: vi.fn(),
      moveTool: vi.fn(),
      toggleToolCollapsed: vi.fn(),
    };
    const framework = new Framework();
    framework.service(ViewService, { view } as any);
    const provider = framework.provider();
    disposeProvider = () => provider.dispose();

    render(
      <MyoxusUIProvider>
        <FrameworkRoot framework={provider}>
          <ContextSurfaceHost />
        </FrameworkRoot>
      </MyoxusUIProvider>,
    );

    const cards = screen.getAllByTestId(/context-surface-/);
    expect(cards).toHaveLength(2);
    expect(
      within(cards[0]!)
        .getByRole("button", { name: "Outline" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      within(cards[1]!)
        .getByRole("button", { name: "Activity" })
        .getAttribute("aria-expanded"),
    ).toBe("false");

    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Outline" }));
    expect(view.toggleToolCollapsed).toHaveBeenCalledWith("outline");
    fireEvent.click(
      within(cards[0]!).getByRole("button", { name: "Remove Outline" }),
    );
    expect(view.hideTool).toHaveBeenCalledWith("outline");

    const handle = within(cards[0]!).getByRole("button", {
      name: "Move Outline",
    });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: " " });
    expect(view.moveTool).toHaveBeenCalledWith("outline", 1);

    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(view.moveTool).toHaveBeenLastCalledWith("outline", 1);

    const moveCountAtBoundary = view.moveTool.mock.calls.length;
    const lastHandle = within(cards[1]!).getByRole("button", {
      name: "Move Activity",
    });
    fireEvent.keyDown(lastHandle, { key: " " });
    fireEvent.keyDown(lastHandle, { key: "ArrowDown" });
    expect(view.moveTool).toHaveBeenCalledTimes(moveCountAtBoundary);

    const activityDropTarget = dndHarness.dropTargets.find(
      (target) => target.data.toolId === "activity",
    );
    activityDropTarget?.onDrop?.({
      source: { data: { type: "workbench-tool", toolId: "outline" } },
      closestEdge: "bottom",
    });
    expect(view.moveTool).toHaveBeenLastCalledWith("outline", 1);
  });
});
