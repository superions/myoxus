// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      Favorite: () => "Favorite",
      Favorited: () => "Favorited",
      "com.myoxus.comment.copy-link": () => "Copy link",
      "com.myoxus.database.database.menu": () => "Database menu",
      "com.myoxus.workbench.split-view.page-menu-open": () => "Open beside",
      "com.myoxus.workbench.tab.page-menu-open": () => "Open in new tab",
      "com.myoxus.workspace-pages.action.open": () => "Open",
      "com.myoxus.workspace-pages.move.title": () => "Move to folder",
      "com.myoxus.moveToTrash.title": () => "Move to trash",
    }) as never,
}));

import { Button, Menu } from "@myoxus/ui-facade";

import { DatabasePageMenuItems } from "./database-page-menu";

afterEach(cleanup);

describe("DatabasePageMenuItems", () => {
  test("renders and invokes the exact typed Database capability set", async () => {
    const actions = {
      copyLink: vi.fn(async () => undefined),
      open: vi.fn(),
      remove: vi.fn(),
      toggleFavorite: vi.fn(),
    };
    const move = vi.fn();
    render(
      <MyoxusUIProvider>
        <Menu
          items={
            <DatabasePageMenuItems
              actions={actions}
              favorite={false}
              onMove={move}
            />
          }
        >
          <Button>Database menu</Button>
        </Menu>
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Database menu" }));
    const menu = await screen.findByRole("menu");
    const expected = [
      "Open",
      "Open beside",
      "Open in new tab",
      "Favorite",
      "Move to folder",
      "Copy link",
      "Move to trash",
    ];
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(expected);

    for (const label of expected) {
      if (!screen.queryByRole("menuitem", { name: label })) {
        fireEvent.click(screen.getByRole("button", { name: "Database menu" }));
      }
      fireEvent.click(await screen.findByRole("menuitem", { name: label }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }

    expect(actions.open.mock.calls).toEqual([[], ["beside"], ["new-tab"]]);
    expect(actions.toggleFavorite).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledOnce();
    expect(actions.copyLink).toHaveBeenCalledOnce();
    expect(actions.remove).toHaveBeenCalledOnce();
    for (const forbidden of [
      "Edit overview",
      "Publish",
      "Export",
      "Version history",
      "Delete permanently",
    ]) {
      expect(screen.queryByText(forbidden)).toBeNull();
    }
  });
});

test("a retained Workspace Tasks identity exposes navigation only", async () => {
  const actions = {
    protectedRoot: true,
    copyLink: vi.fn(async () => undefined),
    open: vi.fn(),
    remove: vi.fn(),
    toggleFavorite: vi.fn(),
  };
  const move = vi.fn();
  render(
    <MyoxusUIProvider>
      <Menu
        items={
          <DatabasePageMenuItems
            actions={actions}
            favorite={false}
            onMove={move}
          />
        }
      >
        <Button>Database menu</Button>
      </Menu>
    </MyoxusUIProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Database menu" }));
  const menu = await screen.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Open", "Open beside", "Open in new tab", "Copy link"]);
  expect(screen.queryByText("Favorite")).toBeNull();
  expect(screen.queryByText("Move to folder")).toBeNull();
  expect(screen.queryByText("Move to trash")).toBeNull();
});
