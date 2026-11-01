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

vi.mock("@myoxus/i18n", async (original) => ({
  ...(await original<typeof import("@myoxus/i18n")>()),
  useI18n: () =>
    ({
      "com.myoxus.common.open-menu": () => "Open menu",
      "com.myoxus.database.create.database": () => "New database",
      "com.myoxus.database.create.project": () => "Create Project",
      "com.myoxus.database.csv-import.title": () => "Import CSV",
      "com.myoxus.database.import-as-new": () => "Import as new Database...",
      "com.myoxus.database.json-import.title": () => "Import JSON snapshot",
      "com.myoxus.database.notion-import.title": () => "Import from Notion",
    }) as any,
}));

import { DatabasesHeaderMenuButton } from ".";

afterEach(cleanup);

function renderMenu(callbacks: {
  onCreateDatabase: () => void;
  onCreateProject: () => void;
  onImportCsv: () => void;
  onImportJson: () => void;
  onImportNotion: () => void;
}) {
  return render(
    <MyoxusUIProvider>
      <DatabasesHeaderMenuButton
        createDatabaseIsMutating={false}
        csvBusy={false}
        jsonBusy={false}
        notionBusy={false}
        {...callbacks}
      />
    </MyoxusUIProvider>,
  );
}

async function openImportSubmenu() {
  fireEvent.click(screen.getByTestId("database-menu-trigger"));
  const importChoice = await screen.findByTestId(
    "database-import-as-new-menu-item",
  );
  expect(importChoice.textContent).toContain("Import as new Database...");
  fireEvent.pointerEnter(importChoice);
  fireEvent.mouseEnter(importChoice);
  return importChoice;
}

describe("DatabasesHeaderMenuButton", () => {
  test("owns both creation commands and invokes every existing import path", async () => {
    const callbacks = {
      onCreateDatabase: vi.fn(),
      onCreateProject: vi.fn(),
      onImportCsv: vi.fn(),
      onImportJson: vi.fn(),
      onImportNotion: vi.fn(),
    };
    renderMenu(callbacks);

    const trigger = screen.getByTestId("database-menu-trigger");
    expect(trigger.dataset.myoxusUiRole).toBe("workbench-header-menu");
    expect(trigger.textContent).toBe("");

    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "New database" }),
    );
    expect(callbacks.onCreateDatabase).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    expect(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Create Project",
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Create Project",
      }),
    );
    expect(callbacks.onCreateProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();

    for (const [name, callback] of [
      ["Import CSV", callbacks.onImportCsv],
      ["Import JSON snapshot", callbacks.onImportJson],
      ["Import from Notion", callbacks.onImportNotion],
    ] as const) {
      await openImportSubmenu();
      fireEvent.click(await screen.findByRole("menuitem", { name }));
      await waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    }
  });

  test("disables only the busy import format and keeps the native choice surface", async () => {
    render(
      <MyoxusUIProvider>
        <DatabasesHeaderMenuButton
          createDatabaseIsMutating={false}
          csvBusy
          jsonBusy={false}
          notionBusy={false}
          onCreateDatabase={vi.fn()}
          onCreateProject={vi.fn()}
          onImportCsv={vi.fn()}
          onImportJson={vi.fn()}
          onImportNotion={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    await openImportSubmenu();
    expect(
      (
        await screen.findByRole("menuitem", { name: "Import CSV" })
      ).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("menuitem", { name: "Import JSON snapshot" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
