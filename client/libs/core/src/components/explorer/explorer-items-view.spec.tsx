/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MyoxusSettingsMantineProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, test, vi } from "vitest";
import {
  ExplorerItemsView,
  type ExplorerItemComponentProps,
} from "./explorer-items-view";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const Item = ({ itemId }: ExplorerItemComponentProps) => (
  <div data-testid="list-row">{itemId}</div>
);
const group = (key: string, size: number) => ({
  key,
  items: Array.from({ length: size }, (_, i) => `${key}-${i}`),
});

test("native virtualization fills a desktop window without mounting a 300-row inventory or collapsed rows", async () => {
  render(
    <MyoxusSettingsMantineProvider>
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 800, itemHeight: 48 }}
      >
        <ExplorerItemsView
          collapsedGroups={["collapsed"]}
          empty={<div>Empty</div>}
          groups={[group("collapsed", 100), group("all", 300)]}
          groupBy
          ItemComponent={Item}
          listScrollOwner="parent"
          onCollapsedGroupsChange={vi.fn()}
          view="list"
        />
      </VirtuosoMockContext.Provider>
    </MyoxusSettingsMantineProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText("all-12").textContent).toBe("all-12"),
  );
  expect(screen.getAllByTestId("list-row").length).toBeLessThan(35);
  expect(screen.queryByText("all-299")).toBeNull();
  expect(screen.queryByText("collapsed-0")).toBeNull();
});

test("measured inventory grid moves the next row after a card grows without mounting the entire catalog", async () => {
  const heights = new Map([
    ["all:all-0", 190],
    ["all:all-1", 270],
    ["all:all-2", 230],
  ]);
  const observers = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observers.set(element, () =>
          this.callback(
            [{ target: element } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve(element: Element) {
        observers.delete(element);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-masonry-root") ? 1160 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-masonry-root") ||
        this.hasAttribute("data-testid")
        ? 800
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return DOMRect.fromRect({
        width: 340,
        height:
          heights.get(this.getAttribute("data-masonry-item-id") ?? "") ?? 180,
      });
    },
  );
  render(
    <MyoxusSettingsMantineProvider>
      <div data-testid="scroll-parent" style={{ overflowY: "auto" }}>
        <ExplorerItemsView
          collapsedGroups={[]}
          empty={<div>Empty</div>}
          groups={[group("all", 120)]}
          groupBy={false}
          ItemComponent={Item}
          measuredCards
          onCollapsedGroupsChange={vi.fn()}
          view="grid"
        />
      </div>
    </MyoxusSettingsMantineProvider>,
  );
  const rowTop = () =>
    Number.parseFloat(
      (
        document.querySelector(
          '[data-masonry-item-id="all:all-3"]',
        ) as HTMLElement
      )?.style.top ?? "NaN",
    );
  // Wait for the measured first row, not its initial width-based estimate.
  await waitFor(() => expect(rowTop()).toBeCloseTo(270 + 24));
  const before = rowTop();
  heights.set("all:all-0", 420);
  const first = document.querySelector('[data-masonry-item-id="all:all-0"]');
  expect(first).not.toBeNull();
  observers.get(first!)?.();
  await waitFor(() => expect(rowTop()).toBeGreaterThan(before + 100));
  expect(document.querySelectorAll("[data-masonry-item]").length).toBeLessThan(
    20,
  );
});
