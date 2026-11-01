import { expect } from "@playwright/test";

import {
  activeNoteInEdgeless,
  createNote,
  edgelessCommonSetup,
  selectNoteInEdgeless,
  triggerComponentToolbarAction,
} from "../utils/actions/edgeless.js";
import { pressEnter, type, waitNextFrame } from "../utils/actions/index.js";

import { test } from "../utils/playwright.js";

test.describe("note to linked doc", () => {
  test("select a note and turn it into a linked doc", async ({ page }) => {
    await edgelessCommonSetup(page);
    const noteId = await createNote(page, [100, 0], "");
    await activeNoteInEdgeless(page, noteId);
    await waitNextFrame(page, 200);
    await type(page, "Hello");
    await pressEnter(page);
    await type(page, "World");

    await page.mouse.click(10, 50);
    await selectNoteInEdgeless(page, noteId);
    await triggerComponentToolbarAction(page, "turnIntoLinkedDoc");

    const embedSyncedBlock = page.locator(
      "myoxus-embed-edgeless-synced-doc-block",
    );
    await expect(embedSyncedBlock).toBeVisible();
    const paragraph = embedSyncedBlock.locator(
      'myoxus-paragraph [data-v-text="true"]',
    );
    await expect(paragraph.nth(0)).toHaveText("Hello");
    await expect(paragraph.nth(1)).toHaveText("World");
  });
});
