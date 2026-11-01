import { test } from "@myoxus-test/kit/playwright";
import { importFile } from "@myoxus-test/kit/utils/attachment";
import {
  clickEdgelessModeButton,
  locateToolbar,
} from "@myoxus-test/kit/utils/editor";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  waitForEmptyEditor,
} from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await openHomePage(page);
  await clickNewPageButton(page);
  await waitForEmptyEditor(page);
});

test.describe("Replaces attachment", () => {
  test("should replace attachment in edgeless", async ({ page }) => {
    await clickEdgelessModeButton(page);

    await page.locator("edgeless-note-tool-button").click();
    await importFile(page, "lorem-ipsum.pdf", async () => {
      await page
        .locator("edgeless-note-menu")
        .getByRole("button", { name: "File", exact: true })
        .click();
    });

    const attachment = page.locator("myoxus-edgeless-attachment").first();
    await attachment.click();

    const name = attachment.locator(".myoxus-attachment-content-title-text");

    await expect(name).toHaveText("lorem-ipsum.pdf");

    const toolbar = locateToolbar(page);
    const replaceButton = toolbar.getByLabel("Replace attachment");

    await importFile(page, "v1-color-palettes-snapshot.zip", async () => {
      await replaceButton.click({ delay: 50 });
    });

    await expect(attachment).toBeVisible();

    await expect(name).toHaveText("v1-color-palettes-snapshot.zip");
  });
});
