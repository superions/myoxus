import { waitNextFrame } from "@myoxus-test/kit/bs/misc";
import { createTable, getCellText } from "@myoxus-test/kit/bs/table";
import { test } from "@myoxus-test/kit/playwright";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

test.describe("Table insertion operations", () => {
  test("should correctly insert rows", async ({ page }) => {
    await openHomePage(page);
    await clickNewPageButton(page);
    await waitForEditorLoad(page);
    await page.keyboard.press("Enter");

    await createTable(page);
    const table = page.locator("myoxus-table");
    await expect(table).toBeVisible();
    const initialCells = table.locator("myoxus-table-cell");
    expect(await initialCells.count()).toBe(4);

    await initialCells.nth(0).hover();
    await waitNextFrame(page);

    const rowOptionButton = table
      .locator('[data-testid="drag-row-handle"]')
      .first();
    await expect(rowOptionButton).toBeVisible();
    await rowOptionButton.click();

    const menu = page.locator("myoxus-menu");
    await expect(menu).toBeVisible();
    await menu.getByText("Insert Below").click();
    await waitNextFrame(page);

    const cellsAfterBelowInsert = table.locator("myoxus-table-cell");
    expect(await cellsAfterBelowInsert.count()).toBe(6);

    const newRowCell1 = cellsAfterBelowInsert.nth(2);
    await newRowCell1.hover();
    await waitNextFrame(page);
    await newRowCell1.click();
    await page.keyboard.type("New Below 1");

    const newRowCell2 = cellsAfterBelowInsert.nth(3);
    await newRowCell2.hover();
    await waitNextFrame(page);
    await newRowCell2.click();
    await page.keyboard.type("New Below 2");

    expect(await getCellText(page, 0)).toBe("Cell1");
    expect(await getCellText(page, 1)).toBe("Cell2");
    expect(await getCellText(page, 2)).toBe("New Below 1");
    expect(await getCellText(page, 3)).toBe("New Below 2");
    expect(await getCellText(page, 4)).toBe("Cell3");
    expect(await getCellText(page, 5)).toBe("Cell4");

    await cellsAfterBelowInsert.nth(0).hover();
    await waitNextFrame(page);
    await expect(rowOptionButton).toBeVisible();
    await rowOptionButton.click();

    await expect(menu).toBeVisible();
    await menu.getByText("Insert Above").click();
    await waitNextFrame(page);

    const cellsAfterAboveInsert = table.locator("myoxus-table-cell");
    expect(await cellsAfterAboveInsert.count()).toBe(8);

    const aboveRowCell1 = cellsAfterAboveInsert.nth(0);
    await aboveRowCell1.hover();
    await waitNextFrame(page);
    await aboveRowCell1.click();
    await page.keyboard.type("New Above 1");

    const aboveRowCell2 = cellsAfterAboveInsert.nth(1);
    await aboveRowCell2.hover();
    await waitNextFrame(page);
    await aboveRowCell2.click();
    await page.keyboard.type("New Above 2");

    expect(await getCellText(page, 0)).toBe("New Above 1");
    expect(await getCellText(page, 1)).toBe("New Above 2");
    expect(await getCellText(page, 2)).toBe("Cell1");
    expect(await getCellText(page, 3)).toBe("Cell2");
  });
});
