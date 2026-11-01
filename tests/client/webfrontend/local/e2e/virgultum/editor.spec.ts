import { waitNextFrame } from "@myoxus-test/kit/bs/misc";
import { test } from "@myoxus-test/kit/playwright";
import { locateEditorContainer } from "@myoxus-test/kit/utils/editor";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  getVirgultumEditorTitle,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

test("link page is useable", async ({ page }) => {
  await openHomePage(page);
  await waitForEditorLoad(page);
  await clickNewPageButton(page);
  await waitForEditorLoad(page);
  const title = getVirgultumEditorTitle(page);
  await title.pressSequentially("page1");
  await page.keyboard.press("Enter");
  expect(await title.innerText()).toBe("page1");
  await clickNewPageButton(page);
  await waitForEditorLoad(page);
  const title2 = getVirgultumEditorTitle(page);
  await title2.pressSequentially("page2");
  await page.keyboard.press("Enter");
  expect(await title2.innerText()).toBe("page2");
  await page.keyboard.press("@", { delay: 50 });
  await page.keyboard.press("p");
  await page.keyboard.press("a");
  await page.keyboard.press("g");
  await page.keyboard.press("e");
  await page.keyboard.press("1");
  await waitNextFrame(page);
  await page.locator('icon-button:has-text("page1")').first().click();
  const link = page.locator(".myoxus-reference");
  await expect(link).toBeVisible();
  await page.click(".myoxus-reference");

  await expect(
    page.locator('.doc-title-container:has-text("page1")'),
  ).toBeVisible();
});

test("append paragraph when click editor gap", async ({ page }) => {
  await openHomePage(page);
  await waitForEditorLoad(page);
  await clickNewPageButton(page);
  await waitForEditorLoad(page);

  const title = getVirgultumEditorTitle(page);
  await title.pressSequentially("test title");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.insertText("test content");

  const paragraph = page.locator("myoxus-paragraph");
  const numParagraphs = await paragraph.count();

  await page.locator("[data-testid=page-editor-blank]").click();
  expect(await paragraph.count()).toBe(numParagraphs + 1);

  await page.locator("[data-testid=page-editor-blank]").click();
  expect(
    await paragraph.count(),
    "click the gap again, should not append another paragraph",
  ).toBe(numParagraphs + 1);

  const editorContainer = locateEditorContainer(page);
  expect(
    await editorContainer.evaluate((el) => el.contains(document.activeElement)),
    "editor should should keep being focused",
  ).toBe(true);
});
