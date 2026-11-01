import { expect } from "@playwright/test";

import {
  dragHandleFromBlockToBlockBottomById,
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
  initThreeLists,
  initThreeParagraphs,
  pressEnter,
  pressShiftTab,
  pressTab,
  type,
} from "./utils/actions/index.js";
import {
  getEditorHostLocator,
  initParagraphsByCount,
} from "./utils/actions/misc.js";
import { assertRichTexts } from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

test("move drag handle in list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeLists(page);
  await assertRichTexts(page, ["123", "456", "789"]);
  await dragHandleFromBlockToBlockBottomById(page, "5", "3", false);
  await expect(page.locator(".myoxus-drop-indicator")).toBeHidden();
  await assertRichTexts(page, ["123", "789", "456"]);
});

test("move drag handle in nested block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await type(page, "-");
  await page.keyboard.press("Space", { delay: 50 });
  await type(page, "1");
  await pressEnter(page);
  await type(page, "2");

  await pressEnter(page);
  await pressTab(page);
  await type(page, "21");
  await pressEnter(page);
  await type(page, "22");
  await pressEnter(page);
  await type(page, "23");
  await pressEnter(page);
  await pressShiftTab(page);

  await type(page, "3");

  await assertRichTexts(page, ["1", "2", "21", "22", "23", "3"]);

  await dragHandleFromBlockToBlockBottomById(page, "5", "7");
  await expect(page.locator(".myoxus-drop-indicator")).toBeHidden();
  await assertRichTexts(page, ["1", "2", "22", "23", "21", "3"]);

  await dragHandleFromBlockToBlockBottomById(page, "3", "8");
  await expect(page.locator(".myoxus-drop-indicator")).toBeHidden();
  await assertRichTexts(page, ["2", "22", "23", "21", "3", "1"]);
});

test("should sync selected-blocks to session-manager when clicking drag handle", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await assertRichTexts(page, ["123", "456", "789"]);

  await focusRichText(page, 1);
  const rect = await page.locator('[data-block-id="1"]').boundingBox();
  if (!rect) {
    throw new Error();
  }
  await page.mouse.move(rect.x + 10, rect.y + 10, { steps: 2 });

  const handle = page.locator(".myoxus-drag-handle-container");
  await handle.click();

  await page.keyboard.press("Backspace");
  await assertRichTexts(page, ["456", "789"]);
});

test("should blur rich-text first on starting block selection", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await assertRichTexts(page, ["123", "456", "789"]);

  await expect(page.locator('[contenteditable="true"]:focus')).toHaveCount(1);

  await dragHandleFromBlockToBlockBottomById(page, "2", "4");
  await expect(page.locator(".myoxus-drop-indicator")).toBeHidden();
  await assertRichTexts(page, ["456", "789", "123"]);

  await expect(page.locator('[contenteditable="true"]:focus')).toHaveCount(0);
});

test("hide drag handle when mouse is hovering over the title", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  const rect = await page.locator(".myoxus-note-block-container").boundingBox();
  if (!rect) {
    throw new Error();
  }
  const dragHandle = page.locator(".myoxus-drag-handle-container");
  // When there is a gap between paragraph blocks, it is the correct behavior for the drag handle to appear
  // when the mouse is over the gap. Therefore, we use rect.y - 20 to make the Y offset greater than the gap between the
  // paragraph blocks.
  await page.mouse.move(rect.x, rect.y - 20, { steps: 2 });
  await expect(dragHandle).toBeHidden();

  await page.mouse.move(rect.x, rect.y, { steps: 2 });
  expect(await dragHandle.isVisible()).toBe(true);
  await expect(dragHandle).toBeVisible();
});

test("drag handle should show on right block when scroll viewport", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initParagraphsByCount(page, 30);

  const editorHost = getEditorHostLocator(page);
  const editors = editorHost.locator("rich-text");
  await editors.nth(28).scrollIntoViewIfNeeded();
  expect(
    await page.locator(".myoxus-page-viewport").evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0);
  const blockRect28 = await editors.nth(28).boundingBox();
  if (!blockRect28) {
    throw new Error();
  }

  await page.mouse.move(blockRect28.x + 10, blockRect28.y + 10);
  const dragHandle = page.locator(".myoxus-drag-handle-container");
  await expect(dragHandle).toBeVisible();

  await page.mouse.move(
    blockRect28.x - 10,
    blockRect28.y + blockRect28.height / 2,
  );
  await page.mouse.down();
  await page.mouse.up();

  const blockSelections = page
    .locator("myoxus-block-selection")
    .locator("visible=true");
  await expect(blockSelections).toHaveCount(1);

  const selectedBlockRect = await blockSelections.nth(0).boundingBox();

  if (!selectedBlockRect) {
    throw new Error();
  }

  expect(blockRect28).toEqual(selectedBlockRect);
});
