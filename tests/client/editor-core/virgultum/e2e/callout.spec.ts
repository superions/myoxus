import { expect, type Page } from "@playwright/test";

import {
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
  pressBackspace,
  pressEnter,
  type,
} from "./utils/actions/index.js";
import { test } from "./utils/playwright.js";

async function enterEmptyParagraph(page: Page) {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
}

test("creates a callout through the slash menu with default emoji and children", async ({
  page,
}) => {
  await enterEmptyParagraph(page);

  await type(page, "/callout");
  await pressEnter(page);
  await type(page, "aaaa");
  await pressEnter(page);
  await type(page, "bbbb");

  const callout = page.locator("myoxus-callout");
  const emoji = callout.getByTestId("callout-emoji");
  const paragraph = callout.locator("myoxus-paragraph");
  const vLine = callout.locator("v-line");

  await expect(callout).toBeVisible();
  await expect(emoji).toContainText("💡");
  await expect(paragraph).toHaveCount(2);
  await expect(vLine).toHaveText(["aaaa", "bbbb"]);
});

test("backspace in an empty callout paragraph unwraps before deleting the callout", async ({
  page,
}) => {
  await enterEmptyParagraph(page);

  await type(page, "/callout");
  await pressEnter(page);

  const paragraph = page.locator("myoxus-paragraph");
  const callout = page.locator("myoxus-callout");
  await expect(paragraph).toHaveCount(2);
  await expect(callout).toHaveCount(1);

  await pressBackspace(page);
  await expect(paragraph).toHaveCount(1);
  await expect(callout).toHaveCount(1);

  await pressBackspace(page);
  await expect(paragraph).toHaveCount(1);
  await expect(callout).toHaveCount(0);
});

test("changes callout appearance through the block toolbar and keeps it undoable", async ({
  page,
}) => {
  await enterEmptyParagraph(page);
  await type(page, "/callout");
  await pressEnter(page);
  await type(page, "Appearance contract");

  const callout = page.locator("myoxus-callout");
  const surface = callout.locator("[data-callout-appearance]");
  await expect(surface).toHaveAttribute("data-callout-appearance", "soft");

  const selectCallout = async () => {
    const box = await callout.boundingBox();
    if (!box) throw new Error("callout is not visible");
    await page.mouse.move(box.x + 8, box.y + 8, { steps: 2 });
    await page.locator(".myoxus-drag-handle-container").click();
  };
  await selectCallout();

  const appearanceButton = page.locator(
    'editor-icon-button[aria-label="Appearance"]:visible',
  );
  await appearanceButton.click();
  await page
    .locator('[data-testid="callout-appearance-accent"]:visible')
    .click();
  await expect(surface).toHaveAttribute("data-callout-appearance", "accent");

  await page.keyboard.press("Control+z");
  await expect(surface).toHaveAttribute("data-callout-appearance", "soft");
  await page.keyboard.press("Control+Shift+z");
  await expect(surface).toHaveAttribute("data-callout-appearance", "accent");
});
