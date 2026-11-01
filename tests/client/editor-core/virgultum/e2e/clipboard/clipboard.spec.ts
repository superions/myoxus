import "../utils/declare-test-window.js";

import { expect, type Page } from "@playwright/test";

import {
  addNewPage,
  captureHistory,
  copyByKeyboard,
  dragOverTitle,
  enterPlaygroundRoom,
  focusRichText,
  focusTitle,
  getClipboardHTML,
  getClipboardSnapshot,
  getClipboardText,
  getCurrentEditorDocId,
  getEditorLocator,
  getPageSnapshot,
  initEmptyParagraphState,
  mockParseDocUrlService,
  pasteByKeyboard,
  pasteContent,
  pressArrowRight,
  pressEnter,
  pressShiftTab,
  pressTab,
  resetHistory,
  selectAllByKeyboard,
  setInlineRangeInSelectedRichText,
  setSelection,
  SHORT_KEY,
  switchReadonly,
  switchToPage,
  type,
  undoByKeyboard,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertBlockTypes,
  assertNestedClipboardHTML,
  assertRichTexts,
  assertText,
  assertTitle,
} from "../utils/asserts.js";
import { scoped, test } from "../utils/playwright.js";

async function getTextBlockIds(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((blocks) =>
    blocks.map((block) => {
      const blockId = (block as HTMLElement).dataset.blockId;
      const numericBlockId = Number(blockId);
      if (!Number.isFinite(numericBlockId)) {
        throw new Error(`Missing numeric block id for ${selector}`);
      }
      return numericBlockId;
    }),
  );
}

async function getParagraphBlockIds(page: Page) {
  return getTextBlockIds(page, "myoxus-paragraph");
}

async function createParagraphBlocks(page: Page, texts: string[]) {
  await focusRichText(page);
  for (const [index, text] of texts.entries()) {
    if (index > 0) {
      await pressEnter(page);
    }
    await type(page, text);
  }
  await waitNextFrame(page);
  return getParagraphBlockIds(page);
}

test(scoped`clipboard copy paste`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "test");
  await setInlineRangeInSelectedRichText(page, 0, 3);
  await waitNextFrame(page);
  await copyByKeyboard(page);
  await focusRichText(page);
  await page.keyboard.press(`${SHORT_KEY}+v`);
  await assertText(page, "testtes");
});

test(scoped`clipboard copy paste title`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusTitle(page);

  await type(page, "test");
  await dragOverTitle(page);
  await waitNextFrame(page);
  await copyByKeyboard(page);
  await focusTitle(page);
  await page.keyboard.press(`${SHORT_KEY}+v`);
  await assertTitle(page, "testtest");
});

test(scoped`clipboard paste html`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  // set up clipboard data using html
  const clipData = {
    "text/html": `<span>aaa</span><span>bbb</span><span>ccc</span><bdi>ddd</bdi>`,
  };
  await waitNextFrame(page);
  await page.evaluate(
    ({ clipData }) => {
      const dT = new DataTransfer();
      const e = new ClipboardEvent("paste", { clipboardData: dT });
      Object.defineProperty(e, "target", {
        writable: false,
        value: document,
      });
      e.clipboardData?.setData("text/html", clipData["text/html"]);
      document.dispatchEvent(e);
    },
    { clipData },
  );
  await assertText(page, "aaabbbcccddd");
});

test(scoped`split block when paste`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await resetHistory(page);

  const clipData = {
    "text/plain": `# text
# h1
`,
  };
  await type(page, "abc");

  await setInlineRangeInSelectedRichText(page, 1, 1);
  await captureHistory(page);
  await pasteContent(page, clipData);
  await waitNextFrame(page);

  await assertRichTexts(page, ["atext", "h1c"]);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["abc"]);

  await type(page, "aa");
  await pressEnter(page);
  await type(page, "bb");
  const topLeft123 = await getEditorLocator(page)
    .locator('[data-block-id="2"] .inline-editor')
    .boundingBox();
  const bottomRight789 = await getEditorLocator(page)
    .locator('[data-block-id="4"] .inline-editor')
    .boundingBox();
  if (!topLeft123) {
    throw new Error("topLeft123 is not found");
  }
  if (!bottomRight789) {
    throw new Error("bottomRight789 is not found");
  }
  await selectAllByKeyboard(page);
  await pressArrowRight(page);
  await pressEnter(page);

  await pasteContent(page, clipData);
  await assertRichTexts(page, ["aaa", "bbc", "text", "h1"]);
});

test(scoped`copy partially selected text`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "123 456 789");

  // select 456
  await setInlineRangeInSelectedRichText(page, 4, 3);
  await copyByKeyboard(page);

  // move to line end
  await setInlineRangeInSelectedRichText(page, 11, 0);
  await pressEnter(page);
  await pasteByKeyboard(page);
  await waitNextFrame(page);

  await assertRichTexts(page, ["123 456 789", "456"]);
});

test("should keep first line format when pasted into a new line", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const clipData = `
- [ ] aaa
`;

  await pasteContent(page, { "text/plain": clipData });
  await waitNextFrame(page);
  await assertRichTexts(page, ["aaa"]);
  await assertBlockTypes(page, ["todo"]);
});

test(scoped`auto identify url`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  // set up clipboard data using html
  const clipData = {
    "text/plain": "test https://www.google.com",
  };
  const before = JSON.parse(await getPageSnapshot(page, true));
  await pasteContent(page, clipData);
  await assertRichTexts(page, [clipData["text/plain"]]);
  const after = JSON.parse(await getPageSnapshot(page, true));
  expect(after.children[0].props).toEqual(before.children[0].props);
  expect(after.children[0].children[0].props.text.delta).toEqual([
    { insert: "test " },
    {
      insert: "https://www.google.com",
      attributes: { link: "https://www.google.com" },
    },
  ]);
});

test(scoped`pasting internal url`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusTitle(page);
  await type(page, "test page");

  await focusRichText(page);
  const docId = await getCurrentEditorDocId(page);
  // Reference titles use workspace metadata; this standalone harness does
  // not run Web's server-backed document-title projection.
  await page.evaluate((docId) => {
    window.collection.meta.setDocMeta(docId, { title: "test page" });
  }, docId);
  await mockParseDocUrlService(page, {
    "http://workspace/doc-id": docId,
  });
  await pasteContent(page, {
    "text/plain": "http://workspace/doc-id",
  });
  await expect(page.locator("myoxus-reference")).toContainText("test page");
});

test(scoped`pasting internal url with params`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusTitle(page);
  await type(page, "test page");

  await focusRichText(page);
  const docId = await getCurrentEditorDocId(page);
  await page.evaluate((docId) => {
    window.collection.meta.setDocMeta(docId, { title: "test page" });
  }, docId);
  await mockParseDocUrlService(page, {
    "http://workspace/doc-id?mode=page&blockIds=rL2_GXbtLU2SsJVfCSmh_": docId,
  });
  await pasteContent(page, {
    "text/plain":
      "http://workspace/doc-id?mode=page&blockIds=rL2_GXbtLU2SsJVfCSmh_",
  });
  await expect(page.locator("myoxus-reference")).toContainText("test page");
});

test(
  scoped`pasting an external URL from clipboard to automatically creating a link from selection`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusTitle(page);
    await type(page, "test page");

    await focusRichText(page);
    await type(page, "title alias");
    await setSelection(page, 1, 6, 1, 11);

    await pasteContent(page, {
      "text/plain": "https://example.com/",
    });
    await expect(page.locator("myoxus-link")).toContainText("alias");
  },
);

test(
  scoped`pasting an internal URL from clipboard to automatically creating a link from selection`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusTitle(page);
    await type(page, "test page");

    await focusRichText(page);
    await type(page, "title alias");
    await setSelection(page, 1, 6, 1, 11);

    const docId = await getCurrentEditorDocId(page);
    await mockParseDocUrlService(page, {
      "http://workspace/doc-id": docId,
    });
    await pasteContent(page, {
      "text/plain": "http://workspace/doc-id",
    });
    await expect(page.locator("myoxus-reference")).toContainText("alias");
  },
);

test(scoped`paste parent block`, async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/3153",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "This is parent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await type(page, "This is child 1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await type(page, "This is child 2");
  await setInlineRangeInSelectedRichText(page, 0, 3);
  await copyByKeyboard(page);
  await focusRichText(page, 2);
  await page.keyboard.press(`${SHORT_KEY}+v`);
  await assertRichTexts(page, [
    "This is parent",
    "This is child 1",
    "This is child 2Thi",
  ]);
});

test(scoped`clipboard copy multi selection`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "abc");
  await pressEnter(page);
  await type(page, "def");
  await setSelection(page, 2, 1, 3, 1);
  await waitNextFrame(page);
  await copyByKeyboard(page);
  await waitNextFrame(page);
  await focusRichText(page, 1);
  await pasteByKeyboard(page);
  await waitNextFrame(page);
  await type(page, "cursor");
  await waitNextFrame(page);
  await assertRichTexts(page, ["abc", "defbc", "dcursor"]);
});

test(scoped`clipboard copy nested items`, async ({ page }, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "abc");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "def");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "ghi");
  await pressEnter(page);
  await pressShiftTab(page);
  await pressShiftTab(page);
  await type(page, "jkl");
  await setSelection(page, 2, 1, 3, 1);
  await waitNextFrame(page);
  await copyByKeyboard(page);

  const text = await getClipboardText(page);
  const html = await getClipboardHTML(page);
  const snapshot = await getClipboardSnapshot(page);
  expect(text + "\n").toMatchSnapshot(`${testInfo.title}-clipboard.md`);
  expect(
    JSON.stringify(snapshot.snapshot.content, null, 2) + "\n",
  ).toMatchSnapshot(`${testInfo.title}-clipboard.json`);
  await assertNestedClipboardHTML(
    page,
    html,
    testInfo.snapshotPath("clipboard-copy-nested-items-clipboard.html"),
  );

  await setSelection(page, 4, 1, 5, 1);
  await waitNextFrame(page);
  await copyByKeyboard(page);

  const text2 = await getClipboardText(page);
  const html2 = await getClipboardHTML(page);
  const snapshot2 = await getClipboardSnapshot(page);
  expect(text2 + "\n").toMatchSnapshot(`${testInfo.title}-clipboard2.md`);
  expect(
    JSON.stringify(snapshot2.snapshot.content, null, 2) + "\n",
  ).toMatchSnapshot(`${testInfo.title}-clipboard2.json`);
  await assertNestedClipboardHTML(
    page,
    html2,
    testInfo.snapshotPath("clipboard-copy-nested-items-clipboard2.html"),
  );
});

test(
  scoped`pasting plain text over a multi-paragraph text selection`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    const paragraphIds = await createParagraphBlocks(page, [
      "hello world",
      "hello world",
      "hello world",
    ]);

    await setSelection(page, paragraphIds[0], 6, paragraphIds[2], 5);
    await pasteContent(page, { "text/plain": "test" });

    await assertRichTexts(page, ["hello test world"]);
  },
);

test(scoped`readonly editor ignores paste mutations`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const [paragraphId] = await createParagraphBlocks(page, [
    "This is a test paragraph",
  ]);
  const initialParagraphCount = (await getParagraphBlockIds(page)).length;

  await switchReadonly(page);

  await setSelection(page, paragraphId, 0, paragraphId, 4);
  await pasteContent(page, {
    "text/plain": " - Added text that should not appear",
  });
  await assertRichTexts(page, ["This is a test paragraph"]);

  await setSelection(page, paragraphId, 4, paragraphId, 4);
  await pressEnter(page);
  await pasteContent(page, { "text/plain": "This should not be pasted" });
  expect((await getParagraphBlockIds(page)).length).toBe(initialParagraphCount);

  await page.evaluate(() =>
    navigator.clipboard.writeText("keyboard paste forbidden"),
  );
  await setSelection(page, paragraphId, 0, paragraphId, 4);
  await pasteByKeyboard(page);
  await assertRichTexts(page, ["This is a test paragraph"]);
});

test(
  scoped`copy and paste paragraph content between docs`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    const sourceText = "Cross-doc paste can't fail again";
    const [paragraphId] = await createParagraphBlocks(page, [sourceText]);

    await setSelection(page, paragraphId, 0, paragraphId, sourceText.length);
    await copyByKeyboard(page);

    const destinationDoc = await addNewPage(page);
    await switchToPage(page, destinationDoc.id);
    await focusRichText(page);
    await pasteByKeyboard(page);

    await assertRichTexts(page, [sourceText]);
  },
);

test(
  scoped`copied paragraph text remains available to clipboard consumers`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    const textForExternal = "External clipboard visibility check";
    const [paragraphId] = await createParagraphBlocks(page, [textForExternal]);

    await setSelection(
      page,
      paragraphId,
      0,
      paragraphId,
      textForExternal.length,
    );
    await copyByKeyboard(page);

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(textForExternal);
  },
);
