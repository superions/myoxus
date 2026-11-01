import { expect, type Page } from "@playwright/test";

import {
  addNote,
  selectNoteInEdgeless,
  switchEditorMode,
  triggerComponentToolbarAction,
  zoomResetByKeyboard,
} from "../../utils/actions/edgeless.js";
import {
  copyByKeyboard,
  pasteByKeyboard,
  selectAllByKeyboard,
} from "../../utils/actions/keyboard.js";
import {
  enterPlaygroundRoom,
  initEmptyEdgelessState,
  waitNextFrame,
} from "../../utils/actions/misc.js";
import { assertRectExist } from "../../utils/asserts.js";
import { test } from "../../utils/playwright.js";

async function setupAndAddNote(page: Page) {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  await zoomResetByKeyboard(page);
  const noteId = await addNote(page, "hello world", 100, 200);
  await page.mouse.click(0, 0);
  return noteId;
}

async function openScalePanel(page: Page, noteId: string) {
  await selectNoteInEdgeless(page, noteId);
  await triggerComponentToolbarAction(page, "changeNoteScale");
  await waitNextFrame(page);
  const scalePanel = page.getByRole("dialog", { name: "Scale", exact: true });
  await expect(scalePanel).toBeVisible();
  return scalePanel;
}

async function checkNoteScale(
  page: Page,
  noteId: string,
  expectedScale: number,
  expectedType: "equal" | "greater" | "less" = "equal",
) {
  const edgelessNote = page.locator(
    `myoxus-edgeless-note[data-block-id="${noteId}"]`,
  );
  const noteContainer = edgelessNote.getByTestId("edgeless-note-container");
  const style = await noteContainer.getAttribute("style");

  if (!style) {
    throw new Error("Style attribute not found");
  }

  const scaleMatch = style.match(/transform:\s*scale\(([\d.]+)\)/);
  if (!scaleMatch) {
    throw new Error("Scale transform not found in style");
  }

  const actualScale = parseFloat(scaleMatch[1]);

  switch (expectedType) {
    case "equal":
      expect(actualScale).toBeCloseTo(expectedScale, 2);
      break;
    case "greater":
      expect(actualScale).toBeGreaterThan(expectedScale);
      break;
    case "less":
      expect(actualScale).toBeLessThan(expectedScale);
  }
}

test.describe("note scale", () => {
  test("Note scale can be changed by a scale preset", async ({ page }) => {
    const noteId = await setupAndAddNote(page);
    const panel = await openScalePanel(page, noteId);
    await panel.getByRole("button", { name: "50%", exact: true }).click();
    await checkNoteScale(page, noteId, 0.5);
  });
  test("Note scale can be changed by scale panel input", async ({ page }) => {
    const noteId = await setupAndAddNote(page);
    const scalePanel = await openScalePanel(page, noteId);

    const scaleInput = scalePanel.getByLabel("Scale", { exact: true });
    await scaleInput.fill("50");
    await page.keyboard.press("Enter");

    await checkNoteScale(page, noteId, 0.5);
  });

  test("Note scale input support copy paste", async ({ page }) => {
    const noteId = await setupAndAddNote(page);
    const scalePanel = await openScalePanel(page, noteId);

    const scaleInput = scalePanel.getByLabel("Scale", { exact: true });
    await scaleInput.click();
    await scaleInput.fill("50");
    await selectAllByKeyboard(page);
    await copyByKeyboard(page);
    await page.mouse.click(0, 0);

    await selectNoteInEdgeless(page, noteId);
    await triggerComponentToolbarAction(page, "changeNoteScale");
    await waitNextFrame(page);

    await scaleInput.click();
    await selectAllByKeyboard(page);
    // This input lives in a toolbar portal, not inside the editor container.
    await pasteByKeyboard(page, false);
    await expect(scaleInput).toHaveValue("50%");
    await page.keyboard.press("Enter");

    await checkNoteScale(page, noteId, 0.5);
  });

  test("Note scale can be changed by shift drag", async ({ page }) => {
    const noteId = await setupAndAddNote(page);
    await selectNoteInEdgeless(page, noteId);

    const edgelessNote = page.locator(
      `myoxus-edgeless-note[data-block-id="${noteId}"]`,
    );
    const noteRect = await edgelessNote.boundingBox();
    assertRectExist(noteRect);
    await page.mouse.move(
      noteRect.x + noteRect.width,
      noteRect.y + noteRect.height,
    );
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(
      noteRect.x + noteRect.width * 2,
      noteRect.y + noteRect.height * 2,
      {
        steps: 10,
      },
    );
    await page.mouse.up();

    // expect style scale to be greater than 1
    await checkNoteScale(page, noteId, 1, "greater");
  });
});
