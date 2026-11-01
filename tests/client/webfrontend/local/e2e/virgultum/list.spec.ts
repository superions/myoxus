import { toolbarButtons } from "@myoxus-test/kit/bs/linked-toolbar";
import { test } from "@myoxus-test/kit/playwright";
import { pressEnter, pressTab } from "@myoxus-test/kit/utils/keyboard";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  createLinkedPage,
  type,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await openHomePage(page);
  await clickNewPageButton(page, "List Test");
  await waitForEditorLoad(page);
});

test.describe("split list", () => {
  test("tab in list should not propagate out of editor", async ({ page }) => {
    await pressEnter(page);
    await type(page, "1. aaa");
    await page.keyboard.press("Enter");
    await pressTab(page);
    await createLinkedPage(page, "Test Page");
    const inlineLink = page.locator("myoxus-reference");
    const { switchViewBtn, cardViewBtn } = toolbarButtons(page);
    const list = page.locator("myoxus-list");
    const card = page.locator("myoxus-embed-linked-doc-block");

    const pressWithCount = async (key: string, count: number) => {
      for (let i = 0; i < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await page.keyboard.press(key);
      }
    };

    await inlineLink.hover();
    await switchViewBtn.click();
    await cardViewBtn.click();

    await expect(list.filter({ has: card })).toHaveCount(1);

    await page.keyboard.press("Shift+Tab");

    await expect(list.filter({ hasNot: card })).toHaveCount(1);

    await pressWithCount("Tab", 5);

    await expect(list.filter({ has: card })).toHaveCount(1);

    await pressWithCount("Shift+Tab", 5);

    await expect(list.filter({ hasNot: card })).toHaveCount(1);
  });
});
