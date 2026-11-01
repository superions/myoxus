import { expect } from "@playwright/test";
import type { DeltaInsert } from "@virgultum/store";

import {
  addNoteFixture,
  captureHistory,
  click,
  enterPlaygroundRoom,
  focusRichText,
  focusTitle,
  getTextOperationSnapshot,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  pressArrowLeft,
  pressArrowRight,
  pressBackspace,
  pressEnter,
  pressForwardDelete,
  pressForwardDeleteWord,
  pressShiftEnter,
  redoByKeyboard,
  setSelection,
  switchEditorMode,
  type,
  undoByKeyboard,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertEmpty,
  assertRichTextInlineDeltas,
  assertRichTexts,
  assertText,
  assertTitle,
} from "../utils/asserts.js";
import { scoped, test } from "../utils/playwright.js";
import { getFormatBar } from "../utils/query.js";

test(scoped`basic init with external text`, async ({ page }) => {
  await enterPlaygroundRoom(page);

  await page.evaluate(() => {
    const { doc } = window;
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text("hello"),
      });
    const note = doc.addBlock("myoxus:note", {}, rootId);
    const title = doc.getBlock(rootId)!.model.props.title;
    title.clear();
    title.insert("hello", 0);

    const text = new window.$virgultum.store.Text("world");
    doc.addBlock("myoxus:paragraph", { text }, note);

    const delta = [
      { insert: "foo " },
      { insert: "bar", attributes: { bold: true } },
    ];
    doc.addBlock(
      "myoxus:paragraph",
      {
        text: new window.$virgultum.store.Text(delta as DeltaInsert[]),
      },
      note,
    );
  });

  await assertTitle(page, "hello");
  await assertRichTexts(page, ["world", "foo bar"]);
  await focusRichText(page);
});

test(scoped`undo/redo with keyboard`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");

  await assertText(page, "hello");
  await undoByKeyboard(page);
  await assertEmpty(page);
  await redoByKeyboard(page);
  await assertText(page, "hello");
});

test(scoped`undo/redo twice after adding block twice`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");
  await pressEnter(page);
  await type(page, "world");
  await assertRichTexts(page, ["hello", "world"]);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["hello"]);

  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["hello"]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["hello", "world"]);
});

test(scoped`should undo/redo works on title`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await waitNextFrame(page);
  await focusTitle(page);
  await type(page, "title");
  await focusRichText(page);
  await type(page, "hello world");

  await assertTitle(page, "title");
  await assertRichTexts(page, ["hello world"]);

  await captureHistory(page);
  await pressBackspace(page, 5);
  await captureHistory(page);
  await focusTitle(page);
  await type(page, " something");

  await assertTitle(page, "title something");
  await assertRichTexts(page, ["hello "]);

  await focusRichText(page);
  await undoByKeyboard(page);
  await assertTitle(page, "title");
  await assertRichTexts(page, ["hello "]);
  await undoByKeyboard(page);
  await assertTitle(page, "title");
  await assertRichTexts(page, ["hello world"]);

  await redoByKeyboard(page);
  await assertTitle(page, "title");
  await assertRichTexts(page, ["hello "]);
  await redoByKeyboard(page);
  await assertTitle(page, "title something");
  await assertRichTexts(page, ["hello "]);
});

test(scoped`undo multi notes`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await addNoteFixture(page);
  await assertRichTexts(page, ["", ""]);

  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["", ""]);
});

test(
  scoped`should be able to delete an emoji completely by pressing backspace once`,
  async ({ page }) => {
    test.info().annotations.push({
      type: "issue",
      description: "https://github.com/example/virgultum/issues/2138",
    });
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "🌷🙅‍♂️🏳️‍🌈");
    await pressBackspace(page);
    await pressBackspace(page);
    await pressBackspace(page);
    await assertText(page, "");
  },
);

test(scoped`delete emoji in the middle of the text`, async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/2138",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "1🌷1🙅‍♂️1🏳️‍🌈1👨‍👩‍👧‍👦1");
  await pressArrowLeft(page, 1);
  await pressBackspace(page);
  await pressArrowLeft(page, 1);
  await pressBackspace(page);
  await pressArrowLeft(page, 1);
  await pressBackspace(page);
  await pressArrowLeft(page, 1);
  await pressBackspace(page);
  await assertText(page, "11111");
});

test(scoped`delete emoji forward`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "1🌷1🙅‍♂️1🏳️‍🌈1👨‍👩‍👧‍👦1");
  await pressArrowLeft(page, 8);
  await pressForwardDelete(page);
  await pressArrowRight(page, 1);
  await pressForwardDelete(page);
  await pressArrowRight(page, 1);
  await pressForwardDelete(page);
  await pressArrowRight(page, 1);
  await pressForwardDelete(page);
  await assertText(page, "11111");
});

test(
  scoped`ZERO_WIDTH_FOR_EMPTY_LINE should be counted by one cursor position`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await pressShiftEnter(page);
    await type(page, "asdfg");
    await pressEnter(page);
    await undoByKeyboard(page);
    await page.waitForTimeout(300);
    await pressBackspace(page);
    await assertRichTexts(page, ["\nasdf"]);
  },
);

test("when no note block, click editing area auto add a new note block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);

  await switchEditorMode(page);
  await page.locator("myoxus-edgeless-note").click({ force: true });
  await pressBackspace(page);
  await switchEditorMode(page);
  const edgelessNote = await page.evaluate(() => {
    return document.querySelector("myoxus-edgeless-note");
  });
  expect(edgelessNote).toBeNull();
  await click(page, { x: 200, y: 280 });

  const pageNote = await page.evaluate(() => {
    return document.querySelector("myoxus-note");
  });
  expect(pageNote).not.toBeNull();
});

test(scoped`automatic identify url text`, async ({ page }, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "abc https://google.com ");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_final.json`,
  );
});

test("ctrl+delete to delete one word forward", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaa bbb ccc");
  await pressArrowLeft(page, 8);
  await pressForwardDeleteWord(page);
  await assertText(page, "aaa ccc");
});

test("extended inline format", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaabbbaaa");

  const { boldBtn, italicBtn, underlineBtn, strikeBtn, codeBtn } =
    getFormatBar(page);
  await setSelection(page, 0, 3, 0, 6);
  await boldBtn.click();
  await italicBtn.click();
  await underlineBtn.click();
  await strikeBtn.click();
  await codeBtn.click();
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aaa",
    },
    {
      insert: "bbb",
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        code: true,
      },
    },
    {
      insert: "aaa",
    },
  ]);

  // aaa|bbbccc
  await setSelection(page, 2, 3, 2, 3);
  await captureHistory(page);
  await type(page, "c");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aaac",
    },
    {
      insert: "bbb",
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        code: true,
      },
    },
    {
      insert: "aaa",
    },
  ]);
  await undoByKeyboard(page);

  // aaab|bbccc
  await setSelection(page, 2, 4, 2, 4);
  await type(page, "c");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aaa",
    },
    {
      insert: "bcbb",
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        code: true,
      },
    },
    {
      insert: "aaa",
    },
  ]);
  await undoByKeyboard(page);

  // aaab|b|bccc
  await setSelection(page, 2, 4, 2, 5);
  await type(page, "c");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aaa",
    },
    {
      insert: "bcb",
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        code: true,
      },
    },
    {
      insert: "aaa",
    },
  ]);
  await undoByKeyboard(page);

  // aaabbb|ccc
  await setSelection(page, 2, 6, 2, 6);
  await type(page, "c");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aaa",
    },
    {
      insert: "bbb",
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        code: true,
      },
    },
    {
      insert: "c",
      attributes: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
      },
    },
    {
      insert: "aaa",
    },
  ]);
});
