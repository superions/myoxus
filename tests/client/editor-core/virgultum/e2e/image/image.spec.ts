import "../utils/declare-test-window.js";

import { expect, type Page } from "@playwright/test";

import {
  activeEmbed,
  copyByKeyboard,
  dragEmbedResizeByTopLeft,
  dragEmbedResizeByTopRight,
  enterPlaygroundRoom,
  getEditorHostLocator,
  initImageState,
  moveToImage,
  pasteByKeyboard,
  pressArrowLeft,
  pressEnter,
  redoByKeyboard,
  type,
  undoByKeyboard,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertImageSize,
  assertRichDragButton,
  assertRichImage,
  assertRichTextInlineRange,
  assertRichTexts,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";

async function focusCaption(page: Page) {
  const toolbar = page.getByTestId("selection-toolbar");
  await toolbar.getByLabel("Caption").click();
}

test("both image resize handles preserve aspect ratio and undo/redo", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initImageState(page);
  await assertRichImage(page, 1);
  await activeEmbed(page);
  await assertRichDragButton(page);
  const image = page.locator(".resizable-img");
  for (const resize of [dragEmbedResizeByTopLeft, dragEmbedResizeByTopRight]) {
    const before = await image.boundingBox();
    if (!before) throw new Error("Image bounds missing before resize");
    await resize(page);
    const after = await image.boundingBox();
    if (!after) throw new Error("Image bounds missing after resize");
    expect(after.width).toBeLessThan(before.width);
    expect(after.height).toBeLessThan(before.height);
    expect(after.width / after.height).toBeCloseTo(
      before.width / before.height,
      2,
    );
    await undoByKeyboard(page);
    await assertImageSize(page, {
      width: Math.floor(before.width),
      height: Math.floor(before.height),
    });
    await redoByKeyboard(page);
    await assertImageSize(page, {
      width: Math.floor(after.width),
      height: Math.floor(after.height),
    });
  }
});

test("can click and delete image", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initImageState(page);
  await assertRichImage(page, 1);

  await activeEmbed(page);
  await page.keyboard.press("Backspace");
  await assertRichImage(page, 0);

  await undoByKeyboard(page);
  await assertRichImage(page, 1);

  await redoByKeyboard(page);
  await assertRichImage(page, 0);
});

test("can click and copy image", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initImageState(page);
  await assertRichImage(page, 1);

  await activeEmbed(page);
  await copyByKeyboard(page);
  await pressEnter(page);
  await waitNextFrame(page);

  await pasteByKeyboard(page);
  await waitNextFrame(page, 200);
  await assertRichImage(page, 2);
});

test("enter shortcut on focusing embed block and its caption", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initImageState(page);
  await assertRichImage(page, 1);

  await getEditorHostLocator(page).focus();
  await moveToImage(page);

  await focusCaption(page);

  const caption = page.locator("myoxus-image block-caption-editor textarea");
  await type(page, "123");

  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/2495",
  });

  // blur
  await page.mouse.click(0, 500);
  await caption.click({ position: { x: 0, y: 0 } });
  await type(page, "abc");
  await expect(caption).toHaveValue("abc123");
});

test("should support the enter key of image caption", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initImageState(page);
  await assertRichImage(page, 1);

  await getEditorHostLocator(page).focus();
  await moveToImage(page);

  await focusCaption(page);

  const caption = page.locator("myoxus-image block-caption-editor textarea");
  await type(page, "abc123");
  await pressArrowLeft(page, 3);
  await pressEnter(page);
  await expect(caption).toHaveValue("abc");

  await assertRichTexts(page, ["123"]);
  await assertRichTextInlineRange(page, 0, 0, 0);
});
