import { test } from "@myoxus-test/kit/playwright";
import { importFile } from "@myoxus-test/kit/utils/attachment";
import {
  clickEdgelessModeButton,
  clickPageModeButton,
  getCodeBlockIds,
  getParagraphIds,
  locateEditorContainer,
} from "@myoxus-test/kit/utils/editor";
import {
  copyByKeyboard,
  cutByKeyboard,
  pasteByKeyboard,
  pressEnter,
} from "@myoxus-test/kit/utils/keyboard";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  addCodeBlock,
  clickNewPageButton,
  type,
  waitForEditorLoad,
} from "@myoxus-test/kit/utils/page-logic";
import { setSelection } from "@myoxus-test/kit/utils/selection";
import { expect, type Page } from "@playwright/test";

const paragraphLocator = "myoxus-note myoxus-paragraph";
const codeBlockLocator = "myoxus-note myoxus-code";

async function createParagraphBlocks(page: Page, texts: string[]) {
  for (const text of texts) {
    await pressEnter(page);
    await type(page, text);
  }
}

async function expectParagraphText(
  page: Page,
  index: number,
  expectedText: string,
) {
  await expect
    .poll(() =>
      page
        .locator(paragraphLocator)
        .nth(index)
        .evaluate((block) => {
          const text = (
            block as HTMLElement & {
              model?: { text?: { toString(): string } };
            }
          ).model?.text;
          return text?.toString() ?? "";
        }),
    )
    .toBe(expectedText);
}

async function expectCodeBlockText(
  page: Page,
  index: number,
  expectedText: string,
) {
  await expect
    .poll(() =>
      page
        .locator(codeBlockLocator)
        .nth(index)
        .evaluate((block) => {
          const text = (
            block as HTMLElement & {
              model?: { text?: { toString(): string } };
            }
          ).model?.text;
          return text?.toString() ?? "";
        }),
    )
    .toBe(expectedText);
}

test.beforeEach(async ({ page }) => {
  await openHomePage(page);
  await clickNewPageButton(page, "Clipboard Test");
  await waitForEditorLoad(page);
});

test("paste copied paragraph snapshot over a multi-block text selection", async ({
  page,
}) => {
  await createParagraphBlocks(page, ["test", "test"]);
  await createParagraphBlocks(page, [
    "hello world",
    "hello world",
    "hello world",
  ]);

  const { blockIds: paragraphIds } = await getParagraphIds(page);
  await setSelection(page, paragraphIds[0], 0, paragraphIds[1], 4);
  await copyByKeyboard(page);

  await setSelection(page, paragraphIds[2], 6, paragraphIds[4], 5);
  await pasteByKeyboard(page);

  await expectParagraphText(page, 2, "hello test");
  await expectParagraphText(page, 3, "test world");
});

test("pasting one paragraph snapshot replaces selected code text", async ({
  page,
}) => {
  await createParagraphBlocks(page, ["test"]);

  await pressEnter(page);
  await addCodeBlock(page);
  await type(page, "hello world hello");

  const { blockIds: paragraphIds } = await getParagraphIds(page);
  await setSelection(page, paragraphIds[0], 0, paragraphIds[0], 4);
  await copyByKeyboard(page);

  const { blockIds: codeBlockIds } = await getCodeBlockIds(page);
  await setSelection(page, codeBlockIds[0], 6, codeBlockIds[0], 11);
  await pasteByKeyboard(page);

  await expectCodeBlockText(page, 0, "hello test hello");
});

test("pasting multiple paragraph snapshots replaces selected code text", async ({
  page,
}) => {
  await createParagraphBlocks(page, ["test", "test", "test"]);

  await pressEnter(page);
  await addCodeBlock(page);
  await type(page, "hello world hello");

  const { blockIds: paragraphIds } = await getParagraphIds(page);
  await setSelection(page, paragraphIds[0], 0, paragraphIds[2], 4);
  await copyByKeyboard(page);

  const { blockIds: codeBlockIds } = await getCodeBlockIds(page);
  await setSelection(page, codeBlockIds[0], 6, codeBlockIds[0], 11);
  await pasteByKeyboard(page);

  await expectCodeBlockText(page, 0, "hello test\ntest\ntest hello");
});

test("copy and paste within a single document still duplicates content", async ({
  page,
}) => {
  const container = locateEditorContainer(page);
  await container.click();

  const intraDocText = "Same doc paste regression guard";
  await type(page, intraDocText);

  const { blockIds } = await getParagraphIds(page);
  await setSelection(page, blockIds[0], 0, blockIds[0], intraDocText.length);
  await copyByKeyboard(page);

  await pressEnter(page);
  await pasteByKeyboard(page);

  await expectParagraphText(page, 1, intraDocText);
});

test.describe("surface-ref block", () => {
  async function setupSurfaceRefBlock(page: Page) {
    await clickEdgelessModeButton(page);
    const container = locateEditorContainer(page);
    await container.click();

    await page.keyboard.press("s");
    await container.click({ position: { x: 100, y: 300 } });
    await page.keyboard.press("f");

    const frameTitle = page.locator("myoxus-frame-title");
    await expect(frameTitle).toBeVisible();
    await frameTitle.click();

    const toolbar = page.locator("myoxus-toolbar-widget editor-toolbar");
    const insertIntoPageButton = toolbar.getByLabel("Insert into Page");
    await expect(insertIntoPageButton).toBeVisible();
    await insertIntoPageButton.click();

    await clickPageModeButton(page);
    await waitForEditorLoad(page);
    await container.click();

    return { container };
  }

  test("paste surface-ref block to another doc as embed-linked-doc block", async ({
    page,
  }) => {
    await setupSurfaceRefBlock(page);

    const surfaceRefBlock = page.locator("myoxus-surface-ref");
    await expect(surfaceRefBlock).toBeVisible();
    await surfaceRefBlock.click();
    await page.waitForSelector("myoxus-surface-ref .focused");
    await copyByKeyboard(page);

    await clickNewPageButton(page, "page2");
    await pressEnter(page);

    await pasteByKeyboard(page);

    const embedLinkedDocBlock = page.locator("myoxus-embed-linked-doc-block");
    await expect(embedLinkedDocBlock).toBeVisible();
    await expect(
      embedLinkedDocBlock.locator(
        ".myoxus-embed-linked-doc-content-title-text",
      ),
    ).toHaveText("Clipboard Test");
  });

  test("cut and paste surface-ref block to same doc should remain surface-ref block", async ({
    page,
  }) => {
    const { container } = await setupSurfaceRefBlock(page);

    const surfaceRefBlock = page.locator("myoxus-surface-ref");
    await expect(surfaceRefBlock).toBeVisible();
    await surfaceRefBlock.click();
    await page.waitForSelector("myoxus-surface-ref .focused");
    await cutByKeyboard(page);

    await container.click();
    await pasteByKeyboard(page);

    await expect(surfaceRefBlock).toHaveCount(1);
    await expect(surfaceRefBlock).toBeVisible();
  });
});

test("should copy single image from edgeless and paste to page", async ({
  page,
}) => {
  await clickEdgelessModeButton(page);

  await page.locator("edgeless-note-tool-button").click();
  await importFile(page, "large-image.png", async () => {
    await page
      .locator("edgeless-note-menu")
      .getByRole("button", { name: "Image", exact: true })
      .click();
  });

  const image = page.locator("myoxus-edgeless-image").first();
  await image.click();
  await copyByKeyboard(page);

  await clickPageModeButton(page);
  await waitForEditorLoad(page);

  await locateEditorContainer(page).click();
  await pasteByKeyboard(page);

  await expect(page.locator("myoxus-page-image")).toBeVisible();
});
