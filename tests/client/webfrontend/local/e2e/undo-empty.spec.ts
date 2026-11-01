import { clickEdgelessModeButton } from "@myoxus-test/kit/utils/editor";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  getVirgultumEditorTitle,
  waitForEmptyEditor,
} from "@myoxus-test/kit/utils/page-logic";
import test, { expect } from "@playwright/test";

test("should be able to undo on empty page", async ({ page }) => {
  await openHomePage(page);
  await clickNewPageButton(page);
  await getVirgultumEditorTitle(page).isVisible();
  await waitForEmptyEditor(page);
  await clickEdgelessModeButton(page);
  await page.keyboard.press("ControlOrMeta+Z");

  // test editor still work
  await page.locator(".edgeless-note-page-content").click({ force: true });
  await page.locator(".edgeless-note-page-content").click({ force: true });
  await page.waitForTimeout(100);
  await page
    .locator(".edgeless-note-page-content")
    .pressSequentially("test text");
  await expect(page.locator(".edgeless-note-page-content")).toContainText(
    "test text",
  );
});
