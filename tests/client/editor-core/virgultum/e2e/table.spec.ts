import { readFile } from "node:fs/promises";

import {
  expect,
  test as persistedTest,
  type Locator,
  type Page,
} from "@playwright/test";
import { readZip } from "../../../../../build/scripts/zip-archive.mjs";
import type { TableBlockModel } from "@virgultum/editor/model";

import {
  enterPlaygroundRoom,
  focusRichText,
  getClipboardText,
  initEmptyParagraphState,
  pressEnter,
  selectAllBlocksByKeyboard,
  SHORT_KEY,
  type,
  waitNextFrame,
} from "./utils/actions/index.js";
import { test } from "./utils/playwright.js";

async function createTable(page: Page) {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "/table");
  await pressEnter(page);
  await waitNextFrame(page);

  const table = page.locator("myoxus-table");
  await expect(table).toBeVisible();
  await expect(table.locator("myoxus-table-cell")).toHaveCount(4);

  for (let index = 0; index < 4; index += 1) {
    await inputToCell(page, table, index, `Cell${index + 1}`);
  }

  return table;
}

async function inputToCell(
  page: Page,
  table: Locator,
  index: number,
  text: string,
) {
  const cell = table.locator("myoxus-table-cell").nth(index);
  await cell.hover();
  await waitNextFrame(page);
  await cell.click();
  await cell.click();
  await page.keyboard.type(text);
}

async function replaceCellText(
  page: Page,
  table: Locator,
  index: number,
  text: string,
) {
  const cell = table.locator("myoxus-table-cell").nth(index);
  await cell.locator("v-line").selectText();
  await page.keyboard.type(text);
  await waitNextFrame(page);
}

async function getCellText(table: Locator, index: number) {
  return table.locator("myoxus-table-cell").nth(index).locator("v-line");
}

for (const [slug, tableCount] of [["meeting-register", 2]] as const) {
  test(`shipped ${slug} bundle supports table Tab navigation and undoable rows`, async ({
    page,
  }) => {
    const archive = await readZip(
      await readFile(
        new URL(
          `../../../../../server/templates/documents/${slug}/1.0.1.zip`,
          import.meta.url,
        ),
      ),
    );
    const content = archive.get("content.template.zip");
    expect(content).toBeDefined();
    const bytes = Array.from(content!.data);
    await enterPlaygroundRoom(page);
    await page.evaluate((update) => window.applyNativeUpdate(update), bytes);
    const tables = page.locator("myoxus-table");
    await expect(tables).toHaveCount(tableCount);
    for (let index = 0; index < tableCount; index++) {
      const table = tables.nth(index);
      const cells = table.locator("myoxus-table-cell");
      const editors = table.locator('[contenteditable="true"]');
      const count = await cells.count();
      const columns = await table
        .getByRole("button", { name: "Column options", exact: true })
        .count();
      const originalText = await table.locator("v-line").allTextContents();
      const headers = await table.locator("thead th").count();
      await editors.first().click();
      await page.keyboard.press("Tab");
      await expect(editors.nth(1)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(editors.first()).toBeFocused();
      await editors.last().click();
      await page.keyboard.press("Tab");
      await expect(cells).toHaveCount(count + columns);
      await expect(editors.nth(count)).toBeFocused();
      await expect(table.locator("thead th")).toHaveCount(headers);
      await page.keyboard.press(`${SHORT_KEY}+z`);
      await expect(cells).toHaveCount(count);
      expect(await table.locator("v-line").allTextContents()).toEqual(
        originalText,
      );
    }
  });
}

test("Tab navigates table cells in visual order without editing their content", async ({
  page,
}) => {
  const table = await createTable(page);
  const editors = table.locator('[contenteditable="true"]');
  await editors.nth(0).click();
  for (const index of [1, 2, 3]) {
    await page.keyboard.press("Tab");
    await expect(editors.nth(index)).toBeFocused();
  }
  for (const index of [2, 1, 0]) {
    await page.keyboard.press("Shift+Tab");
    await expect(editors.nth(index)).toBeFocused();
  }
  await page.keyboard.press("Shift+Tab");
  await expect(editors.nth(0)).not.toBeFocused();
  await expect(table.locator("myoxus-table-cell")).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(await getCellText(table, index)).toHaveText(
      `Cell${index + 1}`,
    );
  }
});

test("Tab at the final table cell adds one undoable row and focuses its first cell", async ({
  page,
}) => {
  const table = await createTable(page);
  const editors = table.locator('[contenteditable="true"]');
  await editors.nth(3).click();
  await page.keyboard.press("Tab");
  await expect(table.locator("myoxus-table-cell")).toHaveCount(6);
  await expect(editors.nth(4)).toBeFocused();
  await page.keyboard.type("New row");
  await expect(await getCellText(table, 4)).toHaveText("New row");
  await page.keyboard.press("Shift+Tab");
  await expect(editors.nth(3)).toBeFocused();
  await page.keyboard.press(`${SHORT_KEY}+z`);
  await expect(await getCellText(table, 4)).toHaveText("");
  await page.keyboard.press(`${SHORT_KEY}+z`);
  await expect(table.locator("myoxus-table-cell")).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(await getCellText(table, index)).toHaveText(
      `Cell${index + 1}`,
    );
  }
});

async function openColumnMenu(page: Page, table: Locator, index: number) {
  const cell = table.locator("myoxus-table-cell").nth(index);
  await cell.hover();
  await waitNextFrame(page);

  const handle = table.locator('[data-testid="drag-column-handle"]').nth(index);
  await expect(handle).toBeVisible();
  await handle.click();

  const menu = page.getByRole("menu", { name: "Table", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

test("cell context menu preserves the dragged area through native focus and undo", async ({
  page,
}) => {
  const table = await createTable(page);
  const cells = table.locator("[data-table-cell]");
  const first = (await cells.first().boundingBox())!;
  const last = (await cells.last().boundingBox())!;
  await page.mouse.move(first.x + first.width - 4, first.y + first.height - 4);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 4, last.y + last.height - 4, {
    steps: 12,
  });
  await page.mouse.up();
  const selected = () =>
    table.evaluate(
      (element) => (element as any).selectionController.selected$.value,
    );
  const area = {
    type: "area",
    rowStartIndex: 0,
    rowEndIndex: 1,
    columnStartIndex: 0,
    columnEndIndex: 1,
  };
  await expect.poll(selected).toEqual(area);
  await cells.last().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Table", exact: true });
  await expect
    .poll(() =>
      menu.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await expect.poll(selected).toEqual(area);
  await page
    .getByRole("menuitem", { name: "Clear contents", exact: true })
    .click();
  for (let index = 0; index < 4; index++)
    await expect(await getCellText(table, index)).toHaveText("");
  await expect(table.locator('[contenteditable="true"]').last()).toBeFocused();
  await page.keyboard.press(`${SHORT_KEY}+z`);
  for (let index = 0; index < 4; index++)
    await expect(await getCellText(table, index)).toHaveText(
      `Cell${index + 1}`,
    );
});

test("Tab and column insertion preserve imported ordinal tables and their history", async ({
  page,
}) => {
  const table = await createTable(page);
  await page.evaluate(() => {
    const model = window.doc.getModelsByFlavour("myoxus:table")[0] as any;
    window.doc.transact(() => {
      for (const axis of [model.props.rows, model.props.columns]) {
        Object.values(axis)
          .sort((a: any, b: any) => (a.order < b.order ? -1 : 1))
          .forEach((entry: any, index) => {
            entry.order = String(index).padStart(8, "0");
          });
      }
      model.props.headerRows = 1;
    });
    window.doc.resetHistory();
  });
  const editors = table.locator('[contenteditable="true"]');
  await editors.nth(3).click();
  await page.keyboard.press("Tab");
  await expect(table.locator("myoxus-table-cell")).toHaveCount(6);
  await expect(editors.nth(4)).toBeFocused();
  await expect(table.locator("thead th")).toHaveCount(2);
  await page.keyboard.press(`${SHORT_KEY}+z`);
  await expect(table.locator("myoxus-table-cell")).toHaveCount(4);
  await page.keyboard.press(`${SHORT_KEY}+Shift+z`);
  await expect(table.locator("myoxus-table-cell")).toHaveCount(6);
  await editors.nth(5).click();
  await page.keyboard.press("Tab");
  await expect(table.locator("myoxus-table-cell")).toHaveCount(8);
  for (let index = 0; index < 4; index += 1) {
    await expect(await getCellText(table, index)).toHaveText(
      `Cell${index + 1}`,
    );
  }
  const menu = await openColumnMenu(page, table, 0);
  await menu.getByText("Insert right", { exact: true }).click();
  await expect(table.locator("myoxus-table-cell")).toHaveCount(12);
  await expect(await getCellText(table, 0)).toHaveText("Cell1");
  await expect(await getCellText(table, 2)).toHaveText("Cell2");
  await expect(await getCellText(table, 3)).toHaveText("Cell3");
  await expect(await getCellText(table, 5)).toHaveText("Cell4");
});

async function setColumnAlignment(
  page: Page,
  table: Locator,
  columnIndex: number,
  alignment: "Default" | "Left" | "Center" | "Right",
  keyboard = false,
) {
  await openColumnMenu(page, table, columnIndex);
  const trigger = page.getByRole("menuitem", {
    name: "Alignment",
    exact: true,
  });
  const option = page.getByRole("menuitem", { name: alignment, exact: true });
  if (keyboard) {
    await trigger.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menuitem", { name: "Default", exact: true }),
    ).toBeFocused();
    for (
      let index = 0;
      index < ["Default", "Left", "Center", "Right"].indexOf(alignment);
      index++
    )
      await page.keyboard.press("ArrowDown");
    await expect(option).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await trigger.click();
    await option.click();
  }
  await expect(
    page.getByRole("menu", { name: "Table", exact: true }),
  ).toHaveCount(0);
}

async function getNativeTableState(table: Locator) {
  return table.evaluate((element) => {
    const model = (element as HTMLElement & { model: TableBlockModel }).model;
    const columns = Object.values(model.props.columns).sort(
      (left, right) =>
        left.order.localeCompare(right.order) ||
        left.columnId.localeCompare(right.columnId),
    );
    return {
      alignment: columns.map((column) => column.textAlign ?? null),
      widths: columns.map((column) => column.width ?? null),
      backgrounds: columns.map((column) => column.backgroundColor ?? null),
      presentation: {
        headerRows: model.props.headerRows ?? null,
        appearance: model.props.appearance ?? null,
        density: model.props.density ?? null,
      },
      own: columns.map((column) => Object.hasOwn(column, "textAlign")),
      raw: columns.map((column) =>
        model.yBlock.has(`prop:columns.${column.columnId}.textAlign`),
      ),
      cells: Object.values(model.props.rows)
        .sort(
          (left, right) =>
            left.order.localeCompare(right.order) ||
            left.rowId.localeCompare(right.rowId),
        )
        .flatMap((row) =>
          columns.map((column) =>
            model.props.cells[`${row.rowId}:${column.columnId}`].text.toDelta(),
          ),
        ),
    };
  });
}

async function getPersistedColumnAlignments(page: Page) {
  return (await getNativeTableState(page.locator("myoxus-table").first()))
    .alignment;
}

async function waitForPersistedWorkspace(page: Page, synced = false) {
  // Browser Web waits for the root document before mounting its workbench.
  // A navigation load event does not establish that native readiness boundary.
  await page.waitForFunction(() =>
    Boolean(
      (window as Window & { currentWorkspace?: unknown }).currentWorkspace,
    ),
  );
  await page.evaluate(async (synced) => {
    const workspace = (
      window as Window & {
        currentWorkspace: {
          id: string;
          engine: {
            doc: {
              waitForDocReady(id: string): Promise<void>;
              waitForSynced(id: string, signal: AbortSignal): Promise<void>;
            };
          };
        };
      }
    ).currentWorkspace;
    await workspace.engine.doc.waitForDocReady(workspace.id);
    const docId = location.pathname.split("/").at(-1)!;
    await workspace.engine.doc.waitForDocReady(docId);
    // A rendered edit precedes durable sync; reload only after its existing owner acknowledges it.
    if (synced) {
      const signal = AbortSignal.timeout(20_000);
      await workspace.engine.doc.waitForSynced(docId, signal);
      await workspace.engine.doc.waitForSynced(workspace.id, signal);
    }
  }, synced);
}

// The isolated renderer has no durable document source. Explicit served runs
// reuse the same table controls to prove the consuming application's reload.
if (process.env.MYOXUS_TABLE_BROWSER_URL) {
  persistedTest.describe("persisted Browser Web table", () => {
    persistedTest.use({
      storageState: process.env.MYOXUS_TABLE_STORAGE_STATE,
      serviceWorkers: "block",
    });
    persistedTest(
      "column alignment survives actual reload and Default removes the raw property",
      async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(process.env.MYOXUS_TABLE_BROWSER_URL!);
        await waitForPersistedWorkspace(page);
        const table = page.locator("myoxus-table").first();
        await expect(table).toBeVisible();
        const original = await getNativeTableState(table);
        await setColumnAlignment(page, table, 0, "Center", true);
        await expect(table.locator("rich-text").first()).toHaveCSS(
          "text-align",
          "center",
        );
        await expect(
          table.locator('[contenteditable="true"]').first(),
        ).toBeFocused();
        await waitForPersistedWorkspace(page, true);
        await page.reload();
        await waitForPersistedWorkspace(page);
        await expect(table.locator("rich-text").first()).toHaveCSS(
          "text-align",
          "center",
        );
        const restored = await getNativeTableState(table);
        expect(restored.alignment[0]).toBe("center");
        expect(restored.raw[0]).toBe(true);
        expect(restored.cells).toEqual(original.cells);
        await setColumnAlignment(page, table, 0, "Default", true);
        await expect(table.locator("rich-text").first()).toHaveCSS(
          "text-align",
          "start",
        );
        await waitForPersistedWorkspace(page, true);
        await page.reload();
        await waitForPersistedWorkspace(page);
        await expect(table.locator("rich-text").first()).toHaveCSS(
          "text-align",
          "start",
        );
        const cleared = await getNativeTableState(table);
        expect(cleared.own[0]).toBe(false);
        expect(cleared.raw[0]).toBe(false);
        expect(cleared.cells).toEqual(original.cells);
        // Copy through the consuming host's real access provider, absent from
        // the isolated renderer. Await OS clipboard delivery before selection moves.
        const count = await page.locator("myoxus-table").count();
        const childIds = () =>
          table.evaluate((element) => {
            const model = (element as HTMLElement & { model: TableBlockModel })
              .model;
            return model.store
              .getParent(model)!
              .children.map((child) => child.id);
          });
        const originalChildren = await childIds();
        await page.evaluate(() => navigator.clipboard.writeText(""));
        const sources = await Promise.all(
          (await page.locator("myoxus-table").all()).map(getNativeTableState),
        );
        const focusParagraph = async () => {
          const index = await page
            .locator("myoxus-paragraph .inline-editor")
            .last()
            .evaluate((element) =>
              [
                ...element
                  .closest("editor-host")!
                  .querySelectorAll(".inline-editor"),
              ].indexOf(element),
            );
          await focusRichText(page, index);
        };
        await focusParagraph();
        await selectAllBlocksByKeyboard(page);
        await expect
          .poll(() =>
            table.evaluate((element) => {
              const table = element as HTMLElement & {
                model: TableBlockModel;
                std: {
                  selection: { value: { type: string; blockId: string }[] };
                };
              };
              return table.std.selection.value.some(
                (selection) =>
                  selection.type === "block" &&
                  selection.blockId === table.model.id,
              );
            }),
          )
          .toBe(true);
        await page.keyboard.press(`${SHORT_KEY}+c`);
        await expect.poll(() => getClipboardText(page)).not.toBe("");
        await page.keyboard.press("Enter");
        await focusParagraph();
        await page.keyboard.press(`${SHORT_KEY}+v`);
        await expect(page.locator("myoxus-table")).toHaveCount(count * 2);
        for (let index = 0; index < count; index++) {
          expect(
            await getNativeTableState(
              page.locator("myoxus-table").nth(count + index),
            ),
          ).toEqual(sources[index]);
        }
        await page.keyboard.press(`${SHORT_KEY}+z`);
        await expect(page.locator("myoxus-table")).toHaveCount(count);
        await page.keyboard.press(`${SHORT_KEY}+z`);
        await expect.poll(childIds).toEqual(originalChildren);
        if (original.alignment[0]) {
          const value = original.alignment[0];
          await setColumnAlignment(
            page,
            table,
            0,
            value === "left" ? "Left" : value === "center" ? "Center" : "Right",
          );
        }
        expect(await getNativeTableState(table)).toEqual(original);
        await waitForPersistedWorkspace(page, true);
        expect(errors).toEqual([]);
      },
    );
  });
}

test("template row repeat is keyboard-authorable, uses document history and stays inside its editor owner", async ({
  page,
}) => {
  const table = await createTable(page);
  await replaceCellText(page, table, 2, "{{member.name}}");
  await replaceCellText(page, table, 3, "{{member.email}}");
  // The harness supplies only the host fact. The real table/menu/history and
  // model owners remain active; the served Core projection is covered separately.
  await page.evaluate(() => {
    const { MyoxusHostServiceIdentifier } = window.$virgultum.services;
    const host = window.editor.std.get(MyoxusHostServiceIdentifier);
    host.isTemplateDocument = () => true;
  });
  const openRepeat = async () => {
    await table
      .getByRole("button", { name: "Row options", exact: true })
      .nth(1)
      .click();
    await page
      .getByRole("menuitem", { name: "Repeat for", exact: true })
      .click();
    await expect(page.locator("myoxus-menu input")).toBeFocused();
  };
  await openRepeat();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("myoxus-menu")).toHaveCount(0);
  await expect(table.locator('[contenteditable="true"]').nth(2)).toBeFocused();
  await expect(await getCellText(table, 2)).toHaveText("{{member.name}}");
  await openRepeat();
  await page
    .locator("myoxus-menu-button")
    .filter({ hasText: "Remove repeat" })
    .click();
  await expect(table.locator('[contenteditable="true"]').nth(2)).toBeFocused();
  await page.keyboard.press(`${SHORT_KEY}+z`);
  await openRepeat();
  await expect(
    page.locator("myoxus-menu-button").filter({ hasText: "Remove repeat" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(table.locator('[contenteditable="true"]').nth(2)).toBeFocused();
  await page.keyboard.press(`${SHORT_KEY}+Shift+z`);
  await openRepeat();
  await expect(
    page.locator("myoxus-menu-button").filter({ hasText: "Remove repeat" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(await getCellText(table, 2)).toHaveText("{{member.name}}");
  await expect(await getCellText(table, 3)).toHaveText("{{member.email}}");
  await table
    .getByRole("button", { name: "Row options", exact: true })
    .nth(1)
    .click();
  const bounds = await page
    .getByRole("menu", { name: "Table", exact: true })
    .boundingBox();
  const owner = await page.locator("editor-host").boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(Math.max(0, owner!.y));
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.getByRole("menuitem", { name: "Repeat for", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.doc.readonly = true;
  });
  await expect(
    table.getByRole("button", { name: "Row options", exact: true }),
  ).toHaveCount(0);
});

test("table settings author explicit semantic header rows and restore keyboard focus", async ({
  page,
}) => {
  const table = await createTable(page);
  const openSettings = async (handle: Locator) => {
    await handle.click();
    await page
      .getByRole("menuitem", { name: "Table settings", exact: true })
      .click();
  };

  await openSettings(
    table.getByRole("button", { name: "Column options", exact: true }).first(),
  );
  await page.getByRole("menuitem", { name: "First row", exact: true }).click();
  await expect(table.locator("thead th")).toHaveCount(2);
  await expect(table.locator("tbody td")).toHaveCount(2);

  await openSettings(
    table.getByRole("button", { name: "Column options", exact: true }).first(),
  );
  await page.getByRole("menuitem", { name: "Ruled", exact: true }).click();
  await openSettings(
    table.getByRole("button", { name: "Column options", exact: true }).first(),
  );
  await page.getByRole("menuitem", { name: "Compact", exact: true }).click();
  const presentation = table.locator(
    '[data-table-appearance="ruled"][data-table-density="compact"]',
  );
  await expect(presentation).toHaveCount(1);
  await expect(table.locator("td").first()).toHaveCSS(
    "border-left-width",
    "0px",
  );
  await expect(table.locator("td").first()).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(table.locator("rich-text").first()).toHaveCSS(
    "padding-top",
    "4px",
  );
  await expect(table.locator("rich-text").first()).toHaveCSS(
    "padding-left",
    "8px",
  );
  await page.keyboard.press(`${SHORT_KEY}+z`);
  await expect(
    table.locator(
      '[data-table-appearance="ruled"][data-table-density="normal"]',
    ),
  ).toHaveCount(1);
  await page.keyboard.press(`${SHORT_KEY}+Shift+z`);
  await expect(presentation).toHaveCount(1);

  await openSettings(
    table.getByRole("button", { name: "Row options", exact: true }).nth(1),
  );
  await page
    .getByRole("menuitem", { name: "Header through this row", exact: true })
    .click();
  await expect(table.locator("thead th")).toHaveCount(4);
  await expect(table.locator("tbody td")).toHaveCount(0);

  await page.keyboard.press(`${SHORT_KEY}+z`);
  await expect(table.locator("thead th")).toHaveCount(2);
  await page.keyboard.press(`${SHORT_KEY}+Shift+z`);
  await expect(table.locator("thead th")).toHaveCount(4);

  const lastCell = table.locator("myoxus-table-cell").last();
  await lastCell.click();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Table settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lastCell.locator('[contenteditable="true"]')).toBeFocused();

  await page.evaluate(() => {
    window.doc.readonly = true;
  });
  await expect(
    table.getByRole("button", { name: /Row options|Column options/ }),
  ).toHaveCount(0);
});

test("inserts columns from table column menus", async ({ page }) => {
  const table = await createTable(page);
  const cells = table.locator("myoxus-table-cell");
  await expect(cells).toHaveCount(4);

  let menu = await openColumnMenu(page, table, 0);
  await menu.getByText("Insert right").click();
  await waitNextFrame(page);
  await expect(cells).toHaveCount(6);

  await inputToCell(page, table, 1, "New Right");
  await expect(await getCellText(table, 0)).toHaveText("Cell1");
  await expect(await getCellText(table, 1)).toHaveText("New Right");
  await expect(await getCellText(table, 2)).toHaveText("Cell2");

  menu = await openColumnMenu(page, table, 0);
  await menu.getByText("Insert left").click();
  await waitNextFrame(page);
  await expect(cells).toHaveCount(8);

  await inputToCell(page, table, 0, "New Left");
  await expect(await getCellText(table, 0)).toHaveText("New Left");
  await expect(await getCellText(table, 1)).toHaveText("Cell1");
  await expect(await getCellText(table, 2)).toHaveText("New Right");
  await expect(await getCellText(table, 3)).toHaveText("Cell2");

  menu = await openColumnMenu(page, table, 2);
  await menu.getByText("Insert right").click();
  await waitNextFrame(page);
  await expect(cells).toHaveCount(10);
  await replaceCellText(page, table, 3, "Right Edge");
  await expect(await getCellText(table, 3)).toHaveText("Right Edge");
});

test("column alignment persists through editing, structure changes and history", async ({
  page,
  browserName,
}) => {
  const table = (await createTable(page)).first();
  const richText = () => table.locator("rich-text");
  // Seed existing rich cell content independently of the column controls.
  await table.evaluate((element) => {
    const model = (element as HTMLElement & { model: TableBlockModel }).model;
    const rows = Object.values(model.props.rows).sort((a, b) =>
      a.order.localeCompare(b.order),
    );
    const columns = Object.values(model.props.columns).sort((a, b) =>
      a.order.localeCompare(b.order),
    );
    const cell = model.props.cells[`${rows[1].rowId}:${columns[0].columnId}`];
    model.store.transact(() =>
      cell.text.format(0, cell.text.length, { bold: true }),
    );
  });
  const markedCell = (await getNativeTableState(table)).cells[2];
  expect(markedCell.some((part) => part.attributes?.bold === true)).toBe(true);
  const editedText = `Aligned edit ${browserName}-${Date.now()}`;

  await setColumnAlignment(page, table, 0, "Right");
  await expect(richText().nth(0)).toHaveCSS("text-align", "right");
  await expect(richText().nth(2)).toHaveCSS("text-align", "right");
  await expect(table.locator('[contenteditable="true"]').first()).toBeFocused();
  expect(await getPersistedColumnAlignments(page)).toEqual(["right", null]);

  await page.keyboard.press(`${SHORT_KEY}+z`);
  await expect(richText().nth(0)).toHaveCSS("text-align", "start");
  expect(await getPersistedColumnAlignments(page)).toEqual([null, null]);
  await page.keyboard.press(`${SHORT_KEY}+Shift+z`);
  await expect(richText().nth(0)).toHaveCSS("text-align", "right");

  await setColumnAlignment(page, table, 0, "Center", true);
  await expect(richText().nth(0)).toHaveCSS("text-align", "center");
  await setColumnAlignment(page, table, 0, "Left");
  await expect(richText().nth(0)).toHaveCSS("text-align", "left");
  await setColumnAlignment(page, table, 0, "Default", true);
  await expect(richText().nth(0)).toHaveCSS("text-align", "start");
  expect(await getPersistedColumnAlignments(page)).toEqual([null, null]);
  const cleared = await getNativeTableState(table);
  expect(cleared.raw[0]).toBe(false);
  expect(cleared.own[0]).toBe(false);
  expect(cleared.cells[2]).toEqual(markedCell);

  await setColumnAlignment(page, table, 0, "Right");
  await replaceCellText(page, table, 0, editedText);
  await expect(richText().nth(0)).toHaveCSS("text-align", "right");

  let menu = await openColumnMenu(page, table, 0);
  await menu.getByText("Move right").click();
  await expect(await getCellText(table, 1)).toHaveText(editedText);
  await expect(richText().nth(1)).toHaveCSS("text-align", "right");
  expect(await getPersistedColumnAlignments(page)).toEqual([null, "right"]);

  menu = await openColumnMenu(page, table, 1);
  await menu.getByText("Insert left").click();
  await expect(table.locator("myoxus-table-cell")).toHaveCount(6);
  await expect(richText().nth(1)).toHaveCSS("text-align", "start");
  await expect(richText().nth(2)).toHaveCSS("text-align", "right");
  expect(await getPersistedColumnAlignments(page)).toEqual([
    null,
    null,
    "right",
  ]);

  menu = await openColumnMenu(page, table, 2);
  await menu.getByText("Duplicate", { exact: true }).click();
  await expect(table.locator("myoxus-table-cell")).toHaveCount(8);
  const duplicated = await getNativeTableState(table);
  expect(duplicated.alignment).toEqual([null, null, "right", "right"]);
  expect(duplicated.cells[3]).toEqual(duplicated.cells[2]);
  expect(duplicated.cells[7]).toEqual(markedCell);
  await expect(richText().nth(3)).toHaveCSS("text-align", "right");
  await expect(richText().nth(7)).toHaveCSS("text-align", "right");

  await page.evaluate(() => {
    window.doc.readonly = true;
  });
  await expect(
    table.getByRole("button", { name: "Column options", exact: true }),
  ).toHaveCount(0);
  await expect(richText().nth(2)).toHaveCSS("text-align", "right");
});
