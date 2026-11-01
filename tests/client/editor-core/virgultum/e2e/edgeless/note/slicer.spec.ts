import { expect } from "@playwright/test";

import {
  enterPlaygroundRoom,
  initEmptyEdgelessState,
  initSixParagraphs,
  selectNoteInEdgeless,
  switchEditorMode,
  triggerComponentToolbarAction,
} from "../../utils/actions/index.js";

import { test } from "../../utils/playwright.js";

test.describe("note slicer", () => {
  test("could enable and disenable note slicer", async ({ page }) => {
    await enterPlaygroundRoom(page);
    const { noteId } = await initEmptyEdgelessState(page);
    await initSixParagraphs(page);
    await page.evaluate(() => {
      window.doc
        .get(window.$virgultum.services.FeatureFlagService)
        .setFlag("enable_advanced_block_visibility", true);
    });

    await switchEditorMode(page);
    await selectNoteInEdgeless(page, noteId);
    // note slicer button should not be visible when note slicer setting is disenabled
    await expect(page.locator(".note-slicer-button")).toBeHidden();
    await expect(page.locator(".note-slicer-dividing-line")).toHaveCount(0);

    await triggerComponentToolbarAction(page, "changeNoteSlicerSetting");
    // note slicer button should be visible when note slicer setting is enabled
    await expect(page.locator(".note-slicer-button")).toBeVisible();
    await expect(page.locator(".note-slicer-dividing-line")).toHaveCount(5);
  });
});
