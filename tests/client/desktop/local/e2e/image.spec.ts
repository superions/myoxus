import { test } from "@myoxus-test/kit/electron";
import { importImage } from "@myoxus-test/kit/utils/image";
import { pasteByKeyboard } from "@myoxus-test/kit/utils/keyboard";
import {
  clickNewPageButton,
  getVirgultumEditorTitle,
} from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

test("should be able to insert SVG images", async ({ page }) => {
  await page.waitForTimeout(500);
  await clickNewPageButton(page);
  const title = getVirgultumEditorTitle(page);
  await title.focus();
  await page.keyboard.press("Enter");

  await importImage(page, "affine.svg");

  const svg = page.locator("myoxus-image").first();
  await expect(svg).toBeVisible();
});

test("should paste it as PNG after copying SVG", async ({ page }) => {
  await page.waitForTimeout(500);
  await clickNewPageButton(page);
  const title = getVirgultumEditorTitle(page);
  await title.focus();
  await page.keyboard.press("Enter");

  await importImage(page, "affine.svg");

  const svg = page.locator("myoxus-image").first();
  await expect(svg).toBeVisible();

  await svg.hover();

  await page.waitForTimeout(500);
  const toolbar = page.locator("myoxus-toolbar-widget editor-toolbar");
  await expect(toolbar).toBeVisible();

  const moreMenu = toolbar.getByLabel("More menu");
  await moreMenu.click();

  await moreMenu.getByRole("button", { name: /^Copy$/ }).click();

  await svg.click();

  await page.keyboard.press("Enter");
  await pasteByKeyboard(page);

  const png = page.locator("myoxus-image").nth(1);
  await expect(png).toBeVisible();
});
