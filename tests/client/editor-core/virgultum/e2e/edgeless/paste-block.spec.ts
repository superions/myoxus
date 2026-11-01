import { expect, type Page } from "@playwright/test";

import {
  click,
  copyByKeyboard,
  enterPlaygroundRoom,
  focusRichText,
  getAllEdgelessNoteIds,
  getNoteBoundBoxInEdgeless,
  initEmptyEdgelessState,
  pasteByKeyboard,
  pasteTestImage,
  pressEnter,
  pressEnterWithShortkey,
  selectAllByKeyboard,
  switchEditorMode,
  type,
} from "../utils/actions/index.js";
import { test } from "../utils/playwright.js";

test.describe("pasting blocks", () => {
  const initContent = async (page: Page) => {
    // Text
    await type(page, "hello");
    await pressEnter(page);
    // Image
    await pasteTestImage(page);
    await pressEnter(page);
    // Text
    await type(page, "world");
    await pressEnter(page);
    // code
    await type(page, "``` ");
    await type(page, "code");
    await pressEnterWithShortkey(page);
  };
  test("pasting a note block", async ({ page }) => {
    await enterPlaygroundRoom(page);
    const { noteId } = await initEmptyEdgelessState(page);
    await focusRichText(page);
    await initContent(page);
    await switchEditorMode(page);
    await click(page, { x: 0, y: 0 });
    const box = await getNoteBoundBoxInEdgeless(page, noteId);
    await click(page, {
      x: box.x + 10,
      y: box.y + 10,
    });
    await copyByKeyboard(page);
    await pasteByKeyboard(page);
    // not equal to noteId
    const noteIds = await getAllEdgelessNoteIds(page);
    expect(noteIds.length).toBe(2);
    expect(noteIds[0]).toBe(noteId);
    const newNoteId = noteIds[1];
    const newNote = page.locator(
      `myoxus-edgeless-note[data-block-id="${newNoteId}"]`,
    );
    await expect(newNote).toBeVisible();
    const blocks = newNote.locator("[data-block-id]");
    await expect(blocks.nth(0)).toContainText("hello");
    await expect(blocks.nth(1).locator(".resizable-img")).toBeAttached();
    expect(await blocks.nth(1).evaluate((block) => block.model.flavour)).toBe(
      "myoxus:image",
    );
    await expect(blocks.nth(2)).toContainText("world");
    await expect(blocks.nth(3)).toContainText("code");
  });
  test("pasting a note block from doc mode", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyEdgelessState(page);
    await focusRichText(page);
    await type(page, "hello world");

    await selectAllByKeyboard(page);
    await copyByKeyboard(page);

    await switchEditorMode(page);
    await click(page, {
      x: 100,
      y: 100,
    });
    await pasteByKeyboard(page);

    // not equal to noteId
    const noteIds = await getAllEdgelessNoteIds(page);
    expect(noteIds.length).toBe(2);

    const newNoteId = noteIds[1];
    const newNote = page.locator(
      `myoxus-edgeless-note[data-block-id="${newNoteId}"]`,
    );
    await expect(newNote).toBeVisible();
    const blocks = newNote.locator("[data-block-id]");
    await expect(blocks.nth(0)).toContainText("hello world");
  });
});
