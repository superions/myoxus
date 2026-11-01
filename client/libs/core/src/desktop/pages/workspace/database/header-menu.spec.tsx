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
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/i18n")>()),
  useI18n: () =>
    ({
      Rename: () => "Rename",
      "com.myoxus.common.open-menu": () => "Open menu",
      "com.myoxus.database.csv-export.title": () => "Export CSV",
      "com.myoxus.database.csv-import.title": () => "Import CSV",
      "com.myoxus.database.import-as-new": () => "Import as new Database...",
      "com.myoxus.database.json-export.title": () => "Export JSON snapshot",
      "com.myoxus.database.json-import.title": () => "Import JSON snapshot",
      "com.myoxus.database.notion-import.title": () => "Import from Notion",
      "com.myoxus.database.overview.edit": () => "Edit overview",
      "com.myoxus.database.view.copy-link": () => "Copy link",
      "com.myoxus.database.document_link.open": () => "Open document",
      "com.myoxus.moveToTrash.title": () => "Move to trash",
    }) as any,
}));

import {
  DatabaseHeaderMenuButton,
  type DatabaseHeaderMenuButtonProps,
} from "./header-menu";

afterEach(cleanup);

type Callbacks = Pick<
  DatabaseHeaderMenuButtonProps,
  | "onRename"
  | "onEditOverview"
  | "onCopyLink"
  | "onImportCsv"
  | "onImportJson"
  | "onImportNotion"
  | "onExportCsv"
  | "onExportJson"
  | "onTrash"
>;

function MenuHarness({
  callbacks,
  protectedRoot = false,
  setupDocuments,
  onOpenSetupDocument,
  contextualAssistance,
}: {
  callbacks: Callbacks;
  contextualAssistance?: DatabaseHeaderMenuButtonProps["contextualAssistance"];
  protectedRoot?: boolean;
  setupDocuments?: DatabaseHeaderMenuButtonProps["setupDocuments"];
  onOpenSetupDocument?: DatabaseHeaderMenuButtonProps["onOpenSetupDocument"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <DatabaseHeaderMenuButton
      contextualAssistance={contextualAssistance}
      contentImportOnly={protectedRoot}
      canEditMetadata={!protectedRoot}
      canManageLifecycle={!protectedRoot}
      csvBusy={false}
      jsonBusy={false}
      notionBusy={false}
      open={open}
      onOpenChange={setOpen}
      setupDocuments={setupDocuments}
      onOpenSetupDocument={onOpenSetupDocument}
      {...callbacks}
    />
  );
}

function renderMenu(callbacks: Callbacks) {
  return render(
    <MyoxusUIProvider>
      <MenuHarness callbacks={callbacks} />
    </MyoxusUIProvider>,
  );
}

async function openMenu() {
  const trigger = screen.getByTestId("database-detail-header-menu-trigger");
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  return waitFor(() => {
    const menu = document.querySelector<HTMLElement>(
      '[data-myoxus-ui-role="menu-content"]',
    );
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
  });
}

async function invokeDirectItem(name: string) {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}

async function invokeImportItem(name: string) {
  const menu = await openMenu();
  const importChoice = within(menu).getByTestId(
    "database-import-as-new-menu-item",
  );
  expect(importChoice.textContent).toContain("Import as new Database...");
  fireEvent.pointerEnter(importChoice);
  fireEvent.mouseEnter(importChoice);
  await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-myoxus-ui-role="menu-sub-content"]',
    );
    expect(element).not.toBeNull();
  });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

describe("DatabaseHeaderMenuButton", () => {
  test("owns the exact Database command groups and invokes every existing flow", async () => {
    const callbacks: Callbacks = {
      onRename: vi.fn(),
      onEditOverview: vi.fn(),
      onCopyLink: vi.fn(),
      onImportCsv: vi.fn(),
      onImportJson: vi.fn(),
      onImportNotion: vi.fn(),
      onExportCsv: vi.fn(),
      onExportJson: vi.fn(),
      onTrash: vi.fn(),
    };
    renderMenu(callbacks);

    const trigger = screen.getByTestId("database-detail-header-menu-trigger");
    expect(trigger.dataset.myoxusUiRole).toBe("workbench-header-menu");
    expect(trigger.textContent).toBe("");

    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(7);
    expect(
      within(menu)
        .getAllByRole("separator")
        .map((separator) => separator.getAttribute("role")),
    ).toEqual(["separator", "separator"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    await waitFor(() => expect(callbacks.onRename).toHaveBeenCalledOnce());

    for (const [name, callback] of [
      ["Edit overview", callbacks.onEditOverview],
      ["Copy link", callbacks.onCopyLink],
      ["Export CSV", callbacks.onExportCsv],
      ["Export JSON snapshot", callbacks.onExportJson],
      ["Move to trash", callbacks.onTrash],
    ] as const) {
      await invokeDirectItem(name);
      await waitFor(() => expect(callback).toHaveBeenCalledOnce());
    }

    for (const [name, callback] of [
      ["Import CSV", callbacks.onImportCsv],
      ["Import JSON snapshot", callbacks.onImportJson],
      ["Import from Notion", callbacks.onImportNotion],
    ] as const) {
      await invokeImportItem(name);
      await waitFor(() => expect(callback).toHaveBeenCalledOnce());
    }
  });

  test("rejects duplicate, merge and document-only actions", async () => {
    renderMenu({
      onRename: vi.fn(),
      onEditOverview: vi.fn(),
      onCopyLink: vi.fn(),
      onImportCsv: vi.fn(),
      onImportJson: vi.fn(),
      onImportNotion: vi.fn(),
      onExportCsv: vi.fn(),
      onExportJson: vi.fn(),
      onTrash: vi.fn(),
    });

    await openMenu();
    for (const forbidden of [
      "Duplicate",
      "Append",
      "Merge",
      "Publish",
      "Version history",
      "Delete permanently",
    ]) {
      expect(screen.queryByRole("menuitem", { name: forbidden })).toBeNull();
    }
  });
});

test("Workspace Tasks keeps portability and copy-link while omitting metadata/lifecycle commands", async () => {
  const callbacks: Callbacks = {
    onRename: vi.fn(),
    onEditOverview: vi.fn(),
    onCopyLink: vi.fn(),
    onImportCsv: vi.fn(),
    onImportJson: vi.fn(),
    onImportNotion: vi.fn(),
    onExportCsv: vi.fn(),
    onExportJson: vi.fn(),
    onTrash: vi.fn(),
  };
  render(
    <MyoxusUIProvider>
      <MenuHarness callbacks={callbacks} protectedRoot />
    </MyoxusUIProvider>,
  );
  const menu = await openMenu();
  for (const name of ["Rename", "Edit overview", "Move to trash"])
    expect(within(menu).queryByRole("menuitem", { name })).toBeNull();
  expect(
    within(menu).getByRole("menuitem", { name: "Export CSV" }),
  ).not.toBeNull();
  expect(
    within(menu).getByRole("menuitem", { name: "Export JSON snapshot" }),
  ).not.toBeNull();
  expect(
    within(menu).getByRole("menuitem", { name: "Import JSON snapshot" }),
  ).not.toBeNull();
  expect(
    within(menu).queryByTestId("database-import-as-new-menu-item"),
  ).toBeNull();
  expect(within(menu).queryByText("Import CSV")).toBeNull();
  expect(within(menu).queryByText("Import from Notion")).toBeNull();
  await invokeDirectItem("Copy link");
  expect(callbacks.onCopyLink).toHaveBeenCalledOnce();
});
