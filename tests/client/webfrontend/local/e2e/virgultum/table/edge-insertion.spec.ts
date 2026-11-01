import { waitNextFrame } from "@myoxus-test/kit/bs/misc";
import { createTable, getCellText } from "@myoxus-test/kit/bs/table";
import { test } from "@myoxus-test/kit/playwright";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

test.describe("Table edge case insertion operations", () => {
  test("should correctly insert rows at edges", async ({ page }) => {
    await openHomePage(page);
    await clickNewPageButton(page);
    await waitForEditorLoad(page);
    await page.keyboard.press("Enter");

    await createTable(page);
    const table = page.locator("myoxus-table");
    await expect(table).toBeVisible();
    await waitNextFrame(page);

    const cells = table.locator("myoxus-table-cell");
    expect(await cells.count()).toBe(4);

    await cells.nth(0).hover();
    await waitNextFrame(page);

    const rowOptionButton = table
      .locator('[data-testid="drag-row-handle"]')
      .first();
    await expect(rowOptionButton).toBeVisible();
    await rowOptionButton.click();

    const menu = page.locator("myoxus-menu");
    await expect(menu).toBeVisible();
    await menu.getByText("Insert Above").click();
    await waitNextFrame(page);

    const cellsAfterAboveEdgeInsert = table.locator("myoxus-table-cell");
    expect(await cellsAfterAboveEdgeInsert.count()).toBe(6);

    const aboveEdgeCell = cellsAfterAboveEdgeInsert.nth(0);
    await aboveEdgeCell.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type("Above Edge");
    await waitNextFrame(page);

    expect(await getCellText(page, 0)).toBe("Above Edge");
    expect(await getCellText(page, 2)).toBe("Cell1");

    const lastRowCell = cellsAfterAboveEdgeInsert.nth(4);
    await lastRowCell.hover();
    await waitNextFrame(page);

    const lastRowOptionButton = table
      .locator('[data-testid="drag-row-handle"]')
      .nth(2);
    await expect(lastRowOptionButton).toBeVisible();
    await lastRowOptionButton.click();

    await expect(menu).toBeVisible();
    await menu.getByText("Insert Below").click();
    await waitNextFrame(page);

    const cellsAfterBelowEdgeInsert = table.locator("myoxus-table-cell");
    expect(await cellsAfterBelowEdgeInsert.count()).toBe(8);

    const belowEdgeCell = cellsAfterBelowEdgeInsert.nth(6);
    await belowEdgeCell.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type("Below Edge");
    await waitNextFrame(page);

    expect(await getCellText(page, 6)).toBe("Below Edge");
  });
});
