import { expect, test } from "@playwright/test";

import {
  press,
  pressArrowLeft,
  pressBackspace,
  pressEnter,
  pressShiftEnter,
  type,
} from "../../utils/actions/keyboard.js";
import {
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
} from "../../utils/actions/misc.js";
import {
  assertRichTextInlineDeltas,
  assertRichTexts,
} from "../../utils/asserts.js";

test("chinese input", async ({ page, browserName }) => {
  test.skip(
    browserName !== "chromium",
    "CDPSession is only supported in chromium",
  );
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.imeSetComposition", {
      selectionStart: 0,
      selectionEnd: 0,
      text: "n",
    });
    await client.send("Input.imeSetComposition", {
      selectionStart: 0,
      selectionEnd: 1,
      text: "ni",
    });
    await client.send("Input.insertText", { text: "你" });
    await expect(page.locator("myoxus-paragraph rich-text")).toHaveText("你");
    await assertRichTexts(page, ["你"]);
  } finally {
    await client.detach();
  }
});

test("input continuous spaces", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "abc   def");
  await assertRichTexts(page, ["abc   def"]);
  await pressArrowLeft(page, 4);
  await pressShiftEnter(page);
  await assertRichTexts(page, ["abc  \n def"]);
});

test("select from the start of line using shift+arrow", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "abc");
  await pressShiftEnter(page);
  await type(page, "def");
  await pressShiftEnter(page);
  await type(page, "ghi");
  await assertRichTexts(page, ["abc\ndef\nghi"]);
  await pressArrowLeft(page, 3);
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString()))
    .toBe("abc\ndef\n");
  await page.keyboard.press("Shift+ArrowRight");
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString()))
    .toBe("bc\ndef\n");
  await pressBackspace(page);
  await assertRichTexts(page, ["aghi"]);
});

test("caret should move correctly when inline elements are exist", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page, 0);

  // hello 'link doc' world
  await type(page, "hello ");
  await press(page, "@");
  await type(page, "link doc");
  await pressEnter(page);
  await type(page, " world");

  await pressArrowLeft(page, " world".length);
  await pressArrowLeft(page); // on 'linked doc'
  await pressArrowLeft(page); // on the left side of 'linked doc'
  await type(page, "test");

  await assertRichTextInlineDeltas(page, [
    {
      insert: "hello test",
    },
    {
      attributes: {
        reference: {
          pageId: "3",
          type: "LinkedPage",
        },
      },
      insert: " ",
    },
    {
      insert: " world",
    },
  ]);
});
