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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OverflowTabsList, resolveOverflowTabValues, Tabs } from "./index";
import { MyoxusUIProvider } from "./provider";

vi.mock("./responsive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./responsive")>();
  return {
    ...actual,
    useResponsiveElementSize: () => ({
      height: 40,
      ref: () => undefined,
      width: 340,
    }),
  };
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      const role = this.getAttribute("data-myoxus-ui-role");
      const width =
        role === "overflow-tabs-list"
          ? 340
          : role === "overflow-tab-slot"
            ? 100
            : role === "overflow-tabs-more-measure"
              ? 72
              : role === "overflow-tabs-end-control"
                ? 40
                : 0;
      const left = role === "overflow-tabs-end-control" ? 300 : 0;
      return {
        bottom: 40,
        height: 40,
        left,
        right: left + width,
        toJSON: () => ({}),
        top: 0,
        width,
        x: left,
        y: 0,
      };
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OverflowTabsList", () => {
  test("retains the active value while preserving server order", () => {
    const widths = new Map([
      ["first", 100],
      ["second", 100],
      ["third", 100],
      ["long-active", 140],
    ]);

    expect(
      resolveOverflowTabValues({
        activeValue: "first",
        availableWidth: 500,
        itemWidths: widths,
        values: ["first", "second", "third", "long-active"],
      }),
    ).toEqual(["first", "second", "third", "long-active"]);
    expect(
      resolveOverflowTabValues({
        activeValue: "long-active",
        availableWidth: 240,
        itemWidths: widths,
        values: ["first", "second", "third", "long-active"],
      }),
    ).toEqual(["first", "long-active"]);

    expect(
      resolveOverflowTabValues({
        activeValue: "long-active",
        availableWidth: 240,
        itemWidths: new Map([
          ["first", 100],
          ["oversized-middle", 220],
          ["later-short", 40],
          ["long-active", 140],
        ]),
        values: ["first", "oversized-middle", "later-short", "long-active"],
      }),
    ).toEqual(["first", "long-active"]);
  });

  test("selects overflowed views and reorders the full logical list", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    const onValueChange = vi.fn();
    const items = Array.from({ length: 12 }, (_, index) => ({
      label:
        index === 11
          ? "Quarterly roadmap with a deliberately long active name"
          : `View ${index + 1}`,
      textLabel:
        index === 11
          ? "Quarterly roadmap with a deliberately long active name"
          : `View ${index + 1}`,
      value: `view-${index + 1}`,
    }));

    render(
      <MyoxusUIProvider>
        <Tabs value="view-12">
          <OverflowTabsList
            activeValue="view-12"
            endControl={<button type="button">Create</button>}
            items={items}
            moreLabel="More views"
            onReorder={onReorder}
            onValueChange={onValueChange}
            reorderAnnouncement={(item, index, total) =>
              `${item.textLabel} moved to ${index + 1} of ${total}`
            }
            reorderInstruction="Alt Shift Arrow keys"
          />
        </Tabs>
      </MyoxusUIProvider>,
    );

    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", {
            name: "Quarterly roadmap with a deliberately long active name",
          })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.queryByRole("tab", { name: "View 3" })).toBeNull();
    });

    const activeTab = screen.getByRole("tab", {
      name: "Quarterly roadmap with a deliberately long active name",
    });
    activeTab.focus();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "More views" }),
    );
    await user.keyboard("[Enter]");
    const hiddenView = await screen.findByRole("menuitem", { name: "View 3" });
    hiddenView.focus();
    await user.keyboard("[Enter]");
    expect(onValueChange).toHaveBeenCalledWith("view-3");

    fireEvent.keyDown(activeTab, {
      altKey: true,
      key: "ArrowLeft",
      shiftKey: true,
    });
    expect(onReorder).toHaveBeenCalledWith([
      ...items.slice(0, 10).map((item) => item.value),
      "view-12",
      "view-11",
    ]);
    expect(
      screen.getByText(
        "Quarterly roadmap with a deliberately long active name moved to 11 of 12",
      ).textContent,
    ).toBe(
      "Quarterly roadmap with a deliberately long active name moved to 11 of 12",
    );
  });
});
