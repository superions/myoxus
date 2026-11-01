import {
  pressArrowDown,
  pressArrowUp,
  pressBackspace,
  pressEnter,
} from "@myoxus-test/kit/utils/keyboard";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  type,
  waitForEmptyEditor,
} from "@myoxus-test/kit/utils/page-logic";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await openHomePage(page);
  await clickNewPageButton(page);
  await waitForEmptyEditor(page);
  await page.locator("myoxus-paragraph v-line div").click();
});

test("press backspace after callout block", async ({ page }) => {
  await pressEnter(page);
  await pressArrowUp(page);
  await type(page, "/callout\n");
  await pressArrowDown(page);

  const paragraph = page.locator("myoxus-paragraph");
  const callout = page.locator("myoxus-callout");
  expect(await paragraph.count()).toBe(3);
  expect(await callout.count()).toBe(1);

  await pressBackspace(page);
  expect(await paragraph.count()).toBe(3);
  expect(await callout.count()).toBe(1);

  await pressBackspace(page);
  await expect(paragraph).toHaveCount(2);
  await expect(callout).toHaveCount(0);
});
