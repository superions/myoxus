import { expect, type Page } from "@playwright/test";
import type { CodeBlockComponent } from "@virgultum/editor/blocks/code";

import { dragBetweenIndices } from "../utils/actions/drag.js";
import {
  createCodeBlock,
  pressArrowLeft,
  pressArrowUp,
  pressBackspace,
  pressEnter,
  pressEscape,
  pressShiftTab,
  pressTab,
  redoByKeyboard,
  type,
  undoByKeyboard,
} from "../utils/actions/keyboard.js";
import {
  captureHistory,
  enterPlaygroundRoom,
  focusRichText,
  initEmptyCodeBlockState,
  initEmptyParagraphState,
  setSelection,
  waitNextFrame,
} from "../utils/actions/misc.js";
import {
  assertBlockCount,
  assertBlockChildrenIds,
  assertRichTexts,
  assertTitle,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";
import { getFormatBar } from "../utils/query.js";
import { getCodeBlock } from "./utils.js";

async function codeState(page: Page) {
  return page
    .locator("myoxus-code")
    .evaluateAll((blocks: CodeBlockComponent[]) =>
      blocks.map(({ model }) => ({
        id: model.id,
        caption: model.props.caption,
        language: model.props.language,
        text: model.props.text.toDelta(),
        wrap: model.props.wrap,
      })),
    );
}

test("use markdown syntax can create code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaa");
  await pressEnter(page);
  await type(page, "bbb");
  await pressTab(page);
  await pressEnter(page);
  await type(page, "ccc");
  await pressTab(page);

  await assertRichTexts(page, ["aaa", "bbb", "ccc"]);
  await assertBlockChildrenIds(page, "2", ["3"]);
  await assertBlockChildrenIds(page, "3", ["4"]);

  await setSelection(page, 2, 0, 2, 0);
  // |aaa
  //   bbb
  //     ccc

  await type(page, "``` ");

  await assertRichTexts(page, ["", "aaa", "bbb", "ccc"]);
  await assertBlockCount(page, "code", 1);
  await assertBlockChildrenIds(page, "1", ["5", "6", "3"]);
  await assertBlockChildrenIds(page, "3", ["4"]);
  await assertBlockChildrenIds(page, "5", []);
});

test("support ```[lang] to add code block with language", async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/1314",
  });

  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await type(page, "```ts");
  await type(page, " ");

  const codeBlockController = getCodeBlock(page);
  const codeLocator = codeBlockController.codeBlock;
  await expect(codeLocator).toBeVisible();

  const codeRect = await codeLocator.boundingBox();
  if (!codeRect) {
    throw new Error("Failed to get bounding box of code block.");
  }
  const position = {
    x: codeRect.x + codeRect.width / 2,
    y: codeRect.y + codeRect.height / 2,
  };
  await page.mouse.move(position.x, position.y);

  const languageButton = codeBlockController.languageButton;
  await expect(languageButton).toBeVisible();
  await expect(languageButton).toHaveValue("TypeScript");
});

test("use more than three backticks can not create code block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await type(page, "`````");
  await type(page, " ");

  const codeBlockLocator = page.locator("myoxus-code");
  await expect(codeBlockLocator).toBeHidden();
  const inlineCodelocator = page.getByText("```");
  await expect(inlineCodelocator).toBeVisible();
  expect(await inlineCodelocator.count()).toEqual(1);
});

test("use shortcut can create code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await createCodeBlock(page);

  const locator = page.locator("myoxus-code");
  await expect(locator).toBeVisible();
});

test("change code language can work", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();
  await codeBlockController.clickLanguageButton();
  const locator = codeBlockController.langList;
  await expect(locator).toBeVisible();

  await type(page, "rust");
  await page.getByRole("option", { name: "Rust", exact: true }).click();
  await expect(locator).toBeHidden();

  await codeBlockController.codeBlock.hover();
  await expect(codeBlockController.languageButton).toHaveValue("Rust");

  const preference = await page.evaluate(() => {
    const block = document.querySelector("myoxus-code")!;
    const saved = JSON.parse(
      localStorage.getItem("virgultum:code-block:lang-list")!,
    );
    return {
      available: block.langs.map(({ id, name }) => [id, name]).sort(),
      saved: saved
        .map(({ name, label }: { name: string; label: string }) => [
          name,
          label,
        ])
        .sort(),
    };
  });
  expect(preference.saved).toEqual(preference.available);

  expect(await codeState(page)).toMatchObject([{ language: "rust" }]);
  await undoByKeyboard(page);
  expect(await codeState(page)).toMatchObject([{ language: null }]);
  await expect(codeBlockController.languageButton).toHaveAttribute(
    "placeholder",
    "Plain Text",
  );

  // Can switch to another language
  await codeBlockController.clickLanguageButton();
  await type(page, "ty");
  await pressEnter(page);
  await expect(locator).toBeHidden();
  await expect(codeBlockController.languageButton).toHaveValue("TypeScript");
  expect(await codeState(page)).toMatchObject([{ language: "typescript" }]);
});

test("duplicate code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page, { language: "javascript" });

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();

  // change language
  await codeBlockController.clickLanguageButton();
  const langLocator = codeBlockController.langList;
  await expect(langLocator).toBeVisible();
  await type(page, "rust");
  await page.getByRole("option", { name: "Rust", exact: true }).click();

  // add text
  await focusRichText(page);
  await type(page, "let a: u8 = 7");
  await pressEscape(page);
  await waitNextFrame(page, 100);

  // add a caption
  await codeBlockController.codeBlock.hover();
  await codeBlockController.captionButton.click();
  await type(page, "Virgultum");
  await pressEnter(page);

  // turn on wrap
  await codeBlockController.codeBlock.hover();
  await (await codeBlockController.openMore()).wrapButton.click();

  await page.mouse.click(300, 300);
  const paragraphCount = await page.locator("myoxus-paragraph").count();

  // duplicate
  await codeBlockController.codeBlock.hover();
  await (await codeBlockController.openMore()).duplicateButton.click();

  await expect(page.locator("myoxus-code")).toHaveCount(2);
  const [original, duplicate] = await codeState(page);
  expect(duplicate.id).not.toBe(original.id);
  expect(original).toMatchObject({
    caption: "Virgultum",
    language: "rust",
    wrap: true,
    text: [{ insert: "let a: u8 = 7" }],
  });
  expect({ ...duplicate, id: original.id }).toEqual(original);
  await assertBlockCount(page, "paragraph", paragraphCount);
  await page.locator("myoxus-code .inline-editor").last().click();
  await page.keyboard.press("End");
  await type(page, ";");
  const changed = await codeState(page);
  expect(changed[0]).toEqual(original);
  expect(changed[1].text).toEqual([{ insert: "let a: u8 = 7;" }]);
});

test("delete code block in more menu", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page, { language: "javascript" });

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();
  const moreMenu = await codeBlockController.openMore();

  await expect(moreMenu.menu).toBeVisible();
  await moreMenu.deleteButton.click();

  await expect(codeBlockController.codeBlock).toHaveCount(0);
  await assertBlockCount(page, "note", 1);
  await assertBlockChildrenIds(page, "1", []);
});

test("undo and redo works in code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "const a = 10;");
  await assertRichTexts(page, ["const a = 10;"]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["const a = 10;"]);
});

test("toggle code block wrap and undo/redo preserve its text", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);

  const codeBlockController = getCodeBlock(page);
  await focusRichText(page);
  await type(page, "const value = 1;");
  // Establish the content fixture as the preceding history step; this case
  // tests the wrap command, not the editor's typing coalescence window.
  await captureHistory(page);
  expect(await codeState(page)).toMatchObject([{ wrap: false }]);

  await codeBlockController.codeBlock.hover();
  await (await codeBlockController.openMore()).wrapButton.click();

  await page.mouse.click(300, 300);

  expect(await codeState(page)).toMatchObject([{ wrap: true }]);
  await focusRichText(page);
  await undoByKeyboard(page);
  expect(await codeState(page)).toMatchObject([
    { wrap: false, text: [{ insert: "const value = 1;" }] },
  ]);
  await redoByKeyboard(page);
  expect(await codeState(page)).toMatchObject([{ wrap: true }]);

  await codeBlockController.codeBlock.hover();
  await (await codeBlockController.openMore()).cancelWrapButton.click();

  expect(await codeState(page)).toMatchObject([
    { wrap: false, text: [{ insert: "const value = 1;" }] },
  ]);
});

test("caption Enter hands input to the following paragraph", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();
  await codeBlockController.captionButton.click();
  await type(page, "Virgultum");
  const caption = page.locator("block-caption-editor textarea");
  const presentation = await caption.evaluate((input) => ({
    height: input.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(input).lineHeight),
    align: getComputedStyle(input).textAlign,
  }));
  expect(presentation.align).toBe("center");
  expect(presentation.height).toBeLessThanOrEqual(presentation.lineHeight + 1);
  await page.keyboard.press("ArrowLeft");
  await pressEnter(page);
  await type(page, "Next ");
  await expect(page.locator("block-caption-editor textarea")).toHaveValue(
    "Virgultu",
  );
  await assertRichTexts(page, ["", "Next m"]);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);
});

test("toggle code block line number can work", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  const lineNumber = page.locator("myoxus-code .line-number");

  await expect(lineNumber).toBeVisible();

  const codeBlockController = getCodeBlock(page);

  await codeBlockController.codeBlock.hover();
  await (await codeBlockController.openMore()).cancelLineNumberButton.click();

  await page.mouse.click(300, 300);

  await expect(lineNumber).toBeHidden();

  await focusRichText(page);
  await undoByKeyboard(page);
  await expect(lineNumber).toBeVisible();

  await redoByKeyboard(page);
  await expect(lineNumber).toBeHidden();

  await codeBlockController.codeBlock.hover();
  await (await codeBlockController.openMore()).lineNumberButton.click();

  await expect(lineNumber).toBeVisible();
});

test("should tab works in code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "const a = 10;");
  await assertRichTexts(page, ["const a = 10;"]);
  await page.keyboard.press("Tab", { delay: 50 });
  await assertRichTexts(page, ["  const a = 10;"]);
  await page.keyboard.press(`Shift+Tab`, { delay: 50 });
  await assertRichTexts(page, ["const a = 10;"]);

  await page.keyboard.press("Enter", { delay: 50 });
  await type(page, 'const b = "NothingToSay');
  await page.keyboard.press("ArrowUp", { delay: 50 });
  await page.keyboard.press("Enter", { delay: 50 });
  await page.keyboard.press("Tab", { delay: 50 });
  await assertRichTexts(page, ['const a = 10;\n  \nconst b = "NothingToSay"']);
});

test("should code block lang input supports alias", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  const codeBlockController = getCodeBlock(page);
  const codeBlock = codeBlockController.codeBlock;
  await codeBlock.hover();
  await codeBlockController.clickLanguageButton();
  await expect(codeBlockController.langList).toBeVisible();
  await type(page, "文言");
  await pressEnter(page);
  await expect(codeBlockController.languageButton).toHaveValue("Wenyan");
});

test("multi-line indent", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "aaa");
  await pressEnter(page);

  await type(page, "bbb");
  await pressEnter(page);

  await type(page, "ccc");

  await page.keyboard.down("Shift");
  await pressArrowUp(page, 2);
  await page.keyboard.up("Shift");

  await pressTab(page);

  await assertRichTexts(page, ["  aaa\n  bbb\n  ccc"]);

  await pressShiftTab(page);

  await assertRichTexts(page, ["aaa\nbbb\nccc"]);

  await pressShiftTab(page);

  await assertRichTexts(page, ["aaa\nbbb\nccc"]);
});

test("should bracket complete works in code block", async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/1800",
  });
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, 'const a = "');
  await assertRichTexts(page, ['const a = ""']);

  await type(page, "str");
  await assertRichTexts(page, ['const a = "str"']);
  await type(page, "(");
  await assertRichTexts(page, ['const a = "str()"']);
  await type(page, "]");
  await assertRichTexts(page, ['const a = "str(])"']);
});

test("angle bracket is inserted literally in code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "<");

  await assertRichTexts(page, ["<"]);
});

test("auto scroll horizontally when typing", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await type(page, "``` ");

  for (let i = 0; i < 100; i++) {
    await type(page, String(i));
  }

  const richTextScrollLeft1 = await page.evaluate(() => {
    const richText = document.querySelector("myoxus-code rich-text");
    if (!richText) {
      throw new Error("Failed to get rich text");
    }

    return richText.scrollLeft;
  });
  expect(richTextScrollLeft1).toBeGreaterThan(200);

  await pressArrowLeft(page, 5);
  await type(page, "aa");

  const richTextScrollLeft2 = await page.evaluate(() => {
    const richText = document.querySelector("myoxus-code rich-text");
    if (!richText) {
      throw new Error("Failed to get rich text");
    }

    return richText.scrollLeft;
  });

  expect(richTextScrollLeft2).toEqual(richTextScrollLeft1);
});

test("code hotkey should not effect in global", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await pressEnter(page);
  await type(page, "``` ");

  await assertTitle(page, "");
  await assertBlockCount(page, "paragraph", 1);
  await assertBlockCount(page, "code", 1);

  await pressArrowUp(page);
  await pressBackspace(page);
  await type(page, "aaa");

  await assertTitle(page, "aaa");
  await assertBlockCount(page, "paragraph", 0);
  await assertBlockCount(page, "code", 1);
});

test("language selection list should not close when hovering out of code block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page, { language: "javascript" });

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();

  await codeBlockController.clickLanguageButton();
  const langLocator = codeBlockController.langList;
  await expect(langLocator).toBeVisible();

  const bBox = await codeBlockController.codeBlock.boundingBox();
  if (!bBox) throw new Error("Expected bounding box");

  const { x, y, width, height } = bBox;

  // hovering inside the code block should keep the list open
  await page.mouse.move(x + width / 2, y + height / 2);
  await expect(langLocator).toBeVisible();

  // hovering out should not close the list
  await page.mouse.move(x - 10, y - 10);
  await waitNextFrame(page);
  await expect(langLocator).toBeVisible();
});

test("language selection list should not change when hovering over its elements", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();
  await codeBlockController.clickLanguageButton();
  await waitNextFrame(page, 100);

  const langListLocator = codeBlockController.langList;
  const langItemsLocator = langListLocator.getByRole("option");

  // checking first 4 language list items
  for (let i = 0; i < 3; i++) {
    const item = langItemsLocator.nth(i); // current item in language list
    const nextItem = langItemsLocator.nth(i + 1); // next item in language list

    await item.hover();

    const initialItemText = await item.textContent();
    const initialNextItemText = await nextItem.textContent();

    await nextItem.hover();

    const currentItemText = await item.textContent();
    const currentNextItemText = await nextItem.textContent();

    // text content should remain unchanged after next item receives focus
    expect(initialItemText).toBe(currentItemText);
    expect(initialNextItemText).toBe(currentNextItemText);
  }
});

test("format text in code block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "```ts ");
  await waitNextFrame(page, 100);
  await type(page, "const aaa = 1000;");

  expect(await codeState(page)).toMatchObject([
    { language: "typescript", text: [{ insert: "const aaa = 1000;" }] },
  ]);

  const line = page.locator("myoxus-code rich-text v-line > div");
  expect(await line.innerText()).toBe("const aaa = 1000;");

  const { boldBtn, linkBtn } = getFormatBar(page);

  await dragBetweenIndices(page, [0, 1], [0, 2]);
  await boldBtn.click();
  expect(await line.innerText()).toBe("const aaa = 1000;");
  await dragBetweenIndices(page, [0, 4], [0, 7]);
  await boldBtn.click();
  expect(await line.innerText()).toBe("const aaa = 1000;");
  await dragBetweenIndices(page, [0, 8], [0, 16]);
  await boldBtn.click();
  expect(await line.innerText()).toBe("const aaa = 1000;");

  expect((await codeState(page))[0].text).toEqual([
    { insert: "c" },
    { insert: "o", attributes: { bold: true } },
    { insert: "ns" },
    { insert: "t a", attributes: { bold: true } },
    { insert: "a" },
    { insert: "a = 1000", attributes: { bold: true } },
    { insert: ";" },
  ]);

  await dragBetweenIndices(page, [0, 4], [0, 10]);
  await linkBtn.click();
  await type(page, "https://www.baidu.com");
  await pressEnter(page);

  const linkLocator = page.locator('[data-block-id="3"] myoxus-link a');
  expect(await linkLocator.count()).toBe(3);
  await expect(linkLocator.nth(0)).toHaveAttribute(
    "href",
    "https://www.baidu.com",
  );
  await expect(linkLocator.nth(1)).toHaveAttribute(
    "href",
    "https://www.baidu.com",
  );
  await expect(linkLocator.nth(2)).toHaveAttribute(
    "href",
    "https://www.baidu.com",
  );

  expect((await codeState(page))[0].text).toEqual([
    { insert: "c" },
    { insert: "o", attributes: { bold: true } },
    { insert: "ns" },
    {
      insert: "t a",
      attributes: { bold: true, link: "https://www.baidu.com" },
    },
    { insert: "a", attributes: { link: "https://www.baidu.com" } },
    { insert: "a ", attributes: { bold: true, link: "https://www.baidu.com" } },
    { insert: "= 1000", attributes: { bold: true } },
    { insert: ";" },
  ]);
});
