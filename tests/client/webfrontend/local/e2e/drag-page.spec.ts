import { test } from "@myoxus-test/kit/playwright";
import {
  clickEdgelessModeButton,
  locateToolbar,
} from "@myoxus-test/kit/utils/editor";
import { pressBackspace, pressEnter } from "@myoxus-test/kit/utils/keyboard";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  createLinkedPage,
  dragTo,
  type,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import {
  getCurrentDocIdFromUrl,
  getDocIdFromUrl,
} from "@myoxus-test/kit/utils/url";
import { expect, type Locator, type Page } from "@playwright/test";

const dragToFavourites = async (
  page: Page,
  dragItem: Locator,
  id: string,
  type: "doc" | "collection" | "tag" | "folder" = "doc",
) => {
  const favourites = page.getByTestId(
    "structure-tree-favorite-category-divider",
  );
  await dragTo(page, dragItem, favourites);
  const item = page
    .getByTestId(`structure-tree-favorites`)
    .locator(`[data-testid="structure-tree-${type}-${id}"]`);
  await expect(item).toBeVisible();
  return item;
};

test.beforeEach(async ({ page }) => {
  await openHomePage(page);
  await waitForEditorLoad(page);
});

// some how this test always timeout, so we skip it
test("drag a page link in editor to favourites", async ({ page }) => {
  await clickNewPageButton(page);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await createLinkedPage(page, "hi from another page");

  const pageReference = page.locator("a").filter({
    has: page.locator(
      '.myoxus-reference-title:has-text("hi from another page")',
    ),
  });

  const pageLink = await pageReference.evaluate(
    (el) => (el as HTMLAnchorElement).href,
  );

  expect(pageLink).toBeTruthy();

  if (!pageLink) {
    return;
  }

  const pageId = getDocIdFromUrl(pageLink);

  await dragToFavourites(
    page,
    page.locator('.myoxus-reference-title:has-text("hi from another page")'),
    pageId,
  );
});

test("drag a page card block to another page", async ({ page }) => {
  await clickNewPageButton(page);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await createLinkedPage(page, "hi from another page");

  const pageReference = page.locator("a").filter({
    has: page.locator(
      '.myoxus-reference-title:has-text("hi from another page")',
    ),
  });

  const pageLink = await pageReference.evaluate(
    (el) => (el as HTMLAnchorElement).href,
  );

  expect(pageLink).toBeTruthy();

  if (!pageLink) {
    return;
  }

  const pageId = getDocIdFromUrl(pageLink);

  await pageReference.hover();

  const toolbar = page.locator("myoxus-toolbar-widget editor-toolbar");

  // convert page reference to card block
  await toolbar.getByRole("button", { name: "Switch view" }).click();
  await toolbar.getByRole("button", { name: "Card view" }).click();

  // hover the card block to show the drag handle
  const box = await page.locator("myoxus-embed-linked-doc-block").boundingBox();

  expect(box).toBeTruthy();

  if (!box) {
    return;
  }

  await page.mouse.move(box.x - 5, box.y + box.height / 2);

  await dragToFavourites(
    page,
    page.locator(".myoxus-drag-handle-container"),
    pageId,
  );
});

test("drag a favourite page into note on page mode", async ({ page }) => {
  await clickNewPageButton(page, "hi from page");
  await page.getByTestId("pin-button").click();
  const pageId = getCurrentDocIdFromUrl(page);
  const item = page
    .getByTestId(`structure-tree-favorites`)
    .locator(`[data-testid="structure-tree-doc-${pageId}"]`);
  await expect(item).toBeVisible();

  // drag item into virgultum editor
  await dragTo(
    page,
    item,
    page.locator(".myoxus-paragraph-block-container").first(),
  );

  await expect(page.locator("myoxus-embed-linked-doc-block")).toContainText(
    "hi from page",
  );
});

test("drag a favourite page into canvas on edgeless mode", async ({ page }) => {
  await clickNewPageButton(page, "hi from page");
  await pressEnter(page);
  await type(page, "Hello world");
  await page.getByTestId("pin-button").click();
  const pageId = getCurrentDocIdFromUrl(page);
  const item = page
    .getByTestId(`structure-tree-favorites`)
    .locator(`[data-testid="structure-tree-doc-${pageId}"]`);
  await expect(item).toBeVisible();

  await clickNewPageButton(page, "edgeless page");
  await clickEdgelessModeButton(page);

  // drag item into virgultum editor
  await dragTo(page, item, page.locator("myoxus-edgeless-root").first());

  const embedDoc = page.locator("myoxus-embed-edgeless-synced-doc-block");
  await expect(embedDoc).toContainText("Hello world");
  await embedDoc.click();

  const toolbar = locateToolbar(page);
  const switchViewButton = toolbar.getByLabel("Switch view");
  await switchViewButton.click();
  await toolbar.getByLabel("Card view").click(); // this will record the view as preferred view
  const cardDoc = page.locator("myoxus-embed-edgeless-linked-doc-block");
  await expect(embedDoc).toBeHidden();
  await expect(cardDoc).toBeVisible();

  await pressBackspace(page);
  await expect(embedDoc).toBeHidden();
  await expect(cardDoc).toBeHidden();

  await dragTo(page, item, page.locator("myoxus-edgeless-root").first());
  await expect(cardDoc).toBeVisible();
  await expect(embedDoc).toBeHidden();

  await page.reload();
  await cardDoc.click();
  await pressBackspace(page);

  await dragTo(page, item, page.locator("myoxus-edgeless-root").first());
  await expect(cardDoc, "prefer view should be persistence").toBeVisible();
  await expect(embedDoc).toBeHidden();
});

test("drag a favourite page into note on edgeless mode", async ({ page }) => {
  await clickNewPageButton(page, "hi from page");
  await pressEnter(page);
  await type(page, "Hello world");
  await page.getByTestId("pin-button").click();
  const pageId = getCurrentDocIdFromUrl(page);
  const item = page
    .getByTestId(`structure-tree-favorites`)
    .locator(`[data-testid="structure-tree-doc-${pageId}"]`);
  await expect(item).toBeVisible();

  await clickNewPageButton(page, "edgeless page");
  await clickEdgelessModeButton(page);

  const edgelessNote = page.locator("myoxus-edgeless-note");
  await dragTo(page, item, edgelessNote);

  const embedDocInNote = edgelessNote.locator("myoxus-embed-synced-doc-block");
  const cardDocInNote = edgelessNote.locator("myoxus-embed-linked-doc-block");

  await expect(embedDocInNote).toBeHidden();
  await expect(cardDocInNote).toBeVisible();

  await edgelessNote.click({ delay: 100 });
  await edgelessNote.click({ delay: 100 });
  await cardDocInNote.click();

  const toolbar = locateToolbar(page);
  const switchViewButton = toolbar.getByLabel("Switch view");
  await switchViewButton.click();
  await toolbar.getByLabel("Embed view").click(); // this should not record the view as preferred view
  await expect(embedDocInNote).toBeVisible();
  await expect(cardDocInNote).toBeHidden();

  await pressBackspace(page);

  await dragTo(page, item, edgelessNote);
  await expect(
    embedDocInNote,
    "prefer view should only be available in canvas",
  ).toBeHidden();
  await expect(cardDocInNote).toBeVisible();
});
