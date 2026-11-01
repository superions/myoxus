import { expect } from "@playwright/test";

import {
  enterPlaygroundRoom,
  initEmptyParagraphState,
} from "../utils/actions/index.js";
import { test } from "../utils/playwright.js";

test("missing image asset renders its fallback without a broken image", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyParagraphState(page);
  await page.evaluate((noteId) => {
    window.doc.addBlock(
      "myoxus:image",
      { sourceId: "missing-image-fixture" },
      noteId,
    );
  }, noteId);
  const fallback = page.locator("myoxus-image-fallback-card");
  await expect(
    fallback.locator(".myoxus-image-fallback-card-title-text"),
  ).toHaveText("Image");
  await expect(
    fallback.locator(".myoxus-image-fallback-card-description"),
  ).toContainText("Image not found");
  await expect(page.locator("myoxus-page-image img")).toHaveCount(0);
});
