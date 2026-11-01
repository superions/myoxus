import { test } from "@myoxus-test/kit/playwright";
import { clickEdgelessModeButton } from "@myoxus-test/kit/utils/editor";
import { withCtrlOrMeta } from "@myoxus-test/kit/utils/keyboard";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  getVirgultumEditorTitle,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import { expect, type Page } from "@playwright/test";

const openQuickSearchByShortcut = async (page: Page, checkVisible = true) => {
  await withCtrlOrMeta(page, () => page.keyboard.press("k", { delay: 50 }));
  if (checkVisible) {
    await expect(page.getByTestId("cmdk-quick-search")).toBeVisible();
  }
};

const selectItem = async (page: Page, label: string) => {
  const selectedEl = page
    .locator('[cmdk-item] [data-testid="cmdk-label"]')
    .filter({ hasText: label });
  await selectedEl.click();
};

const insertInputText = async (page: Page, text: string) => {
  await page.locator("[cmdk-input]").fill(text);
  const actual = await page.locator("[cmdk-input]").inputValue();
  expect(actual).toBe(text);
};

const commandsIsVisible = async (page: Page, label: string) => {
  const locators = page.locator('[cmdk-item] [data-testid="cmdk-label"]');
  const actual = (await locators.allInnerTexts()).find(
    (text) => text === label,
  );
  return !!actual;
};

test("can use cmdk to export png", async ({ page }) => {
  await openHomePage(page);
  await waitForEditorLoad(page);
  await clickNewPageButton(page);
  await getVirgultumEditorTitle(page).click();
  await getVirgultumEditorTitle(page).fill("this is a new page to export");
  await openQuickSearchByShortcut(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    selectItem(page, "Export to PNG"),
  ]);
  expect(download.suggestedFilename()).toBe("this is a new page to export.png");
});

test("can use cmdk to delete page and restore it", async ({ page }) => {
  await openHomePage(page);
  await waitForEditorLoad(page);
  await clickNewPageButton(page);
  await getVirgultumEditorTitle(page).click();
  await getVirgultumEditorTitle(page).fill("this is a new page to delete");
  await openQuickSearchByShortcut(page);
  await selectItem(page, "Move to trash");
  await page.getByTestId("confirm-modal-confirm").click();
  const restoreButton = page.getByTestId("page-restore-button");
  await expect(restoreButton).toBeVisible();
  await page.waitForTimeout(100);
  await openQuickSearchByShortcut(page);
  expect(await commandsIsVisible(page, "Move to trash")).toBe(false);
  expect(await commandsIsVisible(page, "Restore from trash")).toBe(true);
  await selectItem(page, "Restore from trash");
  await expect(restoreButton).not.toBeVisible();
});

test("disable quick search when the link-popup is visitable", async ({
  page,
}) => {
  const specialTitle = '"test"';

  await openHomePage(page);
  await waitForEditorLoad(page);
  await clickNewPageButton(page);

  await openQuickSearchByShortcut(page);
  const quickSearch = page.locator("[data-testid=cmdk-quick-search]");
  await expect(quickSearch).toBeVisible();
  await withCtrlOrMeta(page, () => page.keyboard.press("k"));
  await expect(quickSearch).toBeHidden();

  await getVirgultumEditorTitle(page).click();
  await getVirgultumEditorTitle(page).fill(specialTitle);
  await page.keyboard.press("Enter", { delay: 10 });
  await page.keyboard.insertText("1234567890");
  await page.getByText("1234567890").dblclick();

  await withCtrlOrMeta(page, () => page.keyboard.press("k"));
  const linkPopup = page.locator(".myoxus-link-popover");
  await expect(linkPopup).toBeVisible();
  const currentQuickSearch = page.locator("[data-testid=cmdk-quick-search]");
  await expect(currentQuickSearch).not.toBeVisible();
});

test("can use @ to open quick search to search for doc and insert into canvas", async ({
  page,
}) => {
  await openHomePage(page);
  await waitForEditorLoad(page);

  const url = page.url();

  const docTitle = await page.getByTestId("title-edit-button").innerText();

  await clickNewPageButton(page);
  await clickEdgelessModeButton(page);
  await page.locator("myoxus-edgeless-root").press("@");

  const quickSearch = page.locator("[data-testid=cmdk-quick-search]");
  await expect(quickSearch).toBeVisible();

  // search by using url
  await insertInputText(page, url);

  // expect the default page to be selected
  await expect(
    page.locator('[cmdk-group-items] [cmdk-item][data-selected="true"]'),
  ).toContainText(docTitle);

  // press enter to insert the page to canvas
  await page.keyboard.press("Enter");
  await expect(
    page.locator("myoxus-embed-edgeless-synced-doc-block"),
  ).toBeVisible();
  await expect(
    page.getByTestId("edgeless-embed-synced-doc-title"),
  ).toContainText(docTitle);

  // focus on the note block
  await page.waitForTimeout(500);
  await page
    .locator("myoxus-embed-edgeless-synced-doc-block")
    .click({ force: true });
  await page.waitForTimeout(500);
  // double clock to show peek view
  await page
    .locator("myoxus-embed-edgeless-synced-doc-block")
    .dblclick({ force: true });
  await expect(page.getByTestId("peek-view-modal")).toBeVisible();
});
