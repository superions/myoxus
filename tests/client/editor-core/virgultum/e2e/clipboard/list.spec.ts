import { readFileSync } from "node:fs";

import { expect } from "@playwright/test";

import {
  activeNoteInEdgeless,
  copyByKeyboard,
  createShapeElement,
  cutByKeyboard,
  dragBetweenCoords,
  enterPlaygroundRoom,
  focusRichText,
  getClipboardHTML,
  getClipboardSnapshot,
  getClipboardText,
  getEdgelessSelectedRectModel,
  getInlineSelectionIndex,
  getInlineSelectionText,
  getPageSnapshot,
  getRichTextBoundingBox,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  initThreeParagraphs,
  pasteByKeyboard,
  pasteContent,
  pressArrowLeft,
  pressArrowRight,
  pressEnter,
  pressShiftTab,
  pressSpace,
  pressTab,
  selectAllByKeyboard,
  setInlineRangeInSelectedRichText,
  SHORT_KEY,
  switchEditorMode,
  toViewCoord,
  type,
  undoByKeyboard,
  waitForInlineEditorStateUpdated,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertBlockTypes,
  assertNestedClipboardHTML,
  assertEdgelessSelectedModelRect,
  assertRichTextModelType,
  assertRichTexts,
  assertText,
} from "../utils/asserts.js";
import { scoped, test } from "../utils/playwright.js";

test("paste a non-nested list to a non-nested list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const clipData = {
    "text/plain": `
- a
`,
  };
  await type(page, "-");
  await pressSpace(page);
  await type(page, "123");
  await page.keyboard.press("Control+ArrowLeft");

  // paste on start
  await waitNextFrame(page);
  await pasteContent(page, clipData);
  await pressArrowLeft(page);
  await assertRichTexts(page, ["a123"]);

  // paste in middle
  await pressArrowRight(page, 2);
  await pasteContent(page, clipData);
  await pressArrowRight(page);
  await assertRichTexts(page, ["a1a23"]);

  // paste on end
  await pressArrowRight(page);
  await pasteContent(page, clipData);
  await waitNextFrame(page);
  await assertRichTexts(page, ["a1a23a"]);

  await assertBlockTypes(page, ["bulleted"]);
});

test("copy a nested list by clicking button, the clipboard data should be complete", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const clipData = {
    "text/plain": `
- aaa
  - bbb
    - ccc
`,
  };
  await pasteContent(page, clipData);

  const rootListBound = await page.locator("myoxus-list").first().boundingBox();
  if (!rootListBound) {
    throw new Error("rootListBound is not found");
  }

  // use drag element to test.
  await dragBetweenCoords(
    page,
    { x: rootListBound.x + 1, y: rootListBound.y - 1 },
    { x: rootListBound.x + 1, y: rootListBound.y + rootListBound.height - 1 },
  );
  await copyByKeyboard(page);

  const text = await getClipboardText(page);
  const html = await getClipboardHTML(page);
  const snapshot = await getClipboardSnapshot(page);
  expect(text).toBe("aaa\nbbb\nccc");
  expect(
    JSON.stringify(snapshot.snapshot.content, null, 2) + "\n",
  ).toMatchSnapshot(`${testInfo.title}-clipboard.json`);
  await assertNestedClipboardHTML(
    page,
    html,
    testInfo.snapshotPath(
      "copy-a-nested-list-by-clicking-button-the-clipboard-data-should-be-complete-clipboard.html",
    ),
  );
});

test("paste a nested list to a nested list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const clipData = {
    "text/plain": `
- aaa
  - bbb
    - ccc
`,
  };
  await pasteContent(page, clipData);
  await focusRichText(page, 1);

  // paste on start
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(() => getInlineSelectionIndex(page)).toBe(0);

  /**
   * - aaa
   *   - |bbb
   *     - ccc
   */
  await pasteContent(page, clipData);
  /**
   * - aaa
   *   - aaa
   *     - bbb
   *        - ccc|bbb
   *          -ccc
   */

  await assertRichTexts(page, ["aaa", "aaa", "bbb", "cccbbb", "ccc"]);
  expect(await getInlineSelectionText(page)).toEqual("cccbbb");
  expect(await getInlineSelectionIndex(page)).toEqual(3);

  // paste in middle
  await undoByKeyboard(page);
  await pressArrowRight(page);

  /**
   * - aaa
   *   - b|bb
   *     - ccc
   */
  await pasteContent(page, clipData);
  /**
   * - aaa
   *   - baaa
   *     - bbb
   *       - ccc|bb
   *        - ccc
   */

  await assertRichTexts(page, ["aaa", "baaa", "bbb", "cccbb", "ccc"]);
  expect(await getInlineSelectionText(page)).toEqual("cccbb");
  expect(await getInlineSelectionIndex(page)).toEqual(3);

  // paste on end
  await undoByKeyboard(page);
  await page.keyboard.press("Control+ArrowRight");
  await expect.poll(() => getInlineSelectionIndex(page)).toBe(3);

  /**
   * - aaa
   *   - bbb|
   *     - ccc
   */
  await pasteContent(page, clipData);
  /**
   * - aaa
   *   - bbbaaa
   *     - bbb
   *       - ccc|
   *         - ccc
   */

  await assertRichTexts(page, ["aaa", "bbbaaa", "bbb", "ccc", "ccc"]);
  expect(await getInlineSelectionText(page)).toEqual("ccc");
  expect(await getInlineSelectionIndex(page)).toEqual(3);
});

test("paste nested lists to a nested list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const clipData = {
    "text/plain": `
- aaa
  - bbb
    - ccc
`,
  };
  await pasteContent(page, clipData);
  await focusRichText(page, 1);

  const clipData2 = {
    "text/plain": `
- 111
  - 222
- 111
  - 222
`,
  };

  // paste on start
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(() => getInlineSelectionIndex(page)).toBe(0);

  /**
   * - aaa
   *   - |bbb
   *     - ccc
   */
  await pasteContent(page, clipData2);
  /**
   * - aaa
   *   - 111
   *     - 222
   *   - 111
   *     - 222|bbb
   *       - ccc
   */

  await assertRichTexts(page, ["aaa", "111", "222", "111", "222bbb", "ccc"]);
  expect(await getInlineSelectionText(page)).toEqual("222bbb");
  expect(await getInlineSelectionIndex(page)).toEqual(3);

  // paste in middle
  await undoByKeyboard(page);
  await pressArrowRight(page);

  /**
   * - aaa
   *   - b|bb
   *     - ccc
   */
  await pasteContent(page, clipData2);
  /**
   * - aaa
   *   - b111
   *     - 222
   *   - 111
   *     - 222|bb
   *     - ccc
   */

  await assertRichTexts(page, ["aaa", "b111", "222", "111", "222bb", "ccc"]);
  expect(await getInlineSelectionText(page)).toEqual("222bb");
  expect(await getInlineSelectionIndex(page)).toEqual(3);

  // paste on end
  await undoByKeyboard(page);
  await page.keyboard.press("Control+ArrowRight");
  await expect.poll(() => getInlineSelectionIndex(page)).toBe(3);

  /**
   * - aaa
   *   - bbb|
   *     - ccc
   */
  await pasteContent(page, clipData2);
  /**
   * - aaa
   *   - bbb111
   *     - 222
   *   - 111
   *     - 222|
   *     - ccc
   */

  await assertRichTexts(page, ["aaa", "bbb111", "222", "111", "222", "ccc"]);
  expect(await getInlineSelectionText(page)).toEqual("222");
  expect(await getInlineSelectionIndex(page)).toEqual(3);
});

test("paste non-nested lists to a nested list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const clipData = {
    "text/plain": `
- aaa
  - bbb
`,
  };
  await pasteContent(page, clipData);
  await focusRichText(page, 0);

  const clipData2 = {
    "text/plain": `
- 123
- 456
`,
  };

  // paste on start
  await page.keyboard.press("Control+ArrowLeft");
  await expect.poll(() => getInlineSelectionIndex(page)).toBe(0);

  /**
   * - |aaa
   *   - bbb
   */
  await pasteContent(page, clipData2);
  /**
   * - 123
   * - 456|aaa
   *   - bbb
   */

  await assertRichTexts(page, ["123", "456aaa", "bbb"]);
  expect(await getInlineSelectionText(page)).toEqual("456aaa");
  expect(await getInlineSelectionIndex(page)).toEqual(3);
});

test(scoped`cut should work for multi-block selection`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "a");
  await pressEnter(page);
  await type(page, "b");
  await pressEnter(page);
  await type(page, "c");
  await selectAllByKeyboard(page);
  await selectAllByKeyboard(page);
  await selectAllByKeyboard(page);
  await cutByKeyboard(page);
  await page.locator(".myoxus-page-viewport").click();
  await waitNextFrame(page);
  await assertText(page, "");
});

test(
  scoped`pasting into empty list should not convert the list into paragraph`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "test");
    await setInlineRangeInSelectedRichText(page, 0, 4);
    await copyByKeyboard(page);
    await type(page, "- ");
    await page.keyboard.press(`${SHORT_KEY}+v`);
    await assertRichTexts(page, ["test"]);
    await assertRichTextModelType(page, "bulleted");
  },
);

test("cut will delete all content, and copy will reappear content", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "-");
  await pressSpace(page);
  await type(page, "1");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "2");
  await pressEnter(page);
  await type(page, "3");
  await pressEnter(page);
  await pressShiftTab(page);
  await type(page, "4");

  const before = JSON.parse(await getPageSnapshot(page, true));
  // Preserve every Note property against this run's source. The legacy golden
  // still owns cut/paste content and hierarchy, not a historical theme default.
  const expectedSnapshot = (phase: "cut" | "paste") => {
    const expected = JSON.parse(
      readFileSync(
        testInfo.snapshotPath(
          `cut-will-delete-all-content-and-copy-will-reappear-content-after-${phase}.json`,
        ),
        "utf8",
      ),
    );
    expected.children[0].props = before.children[0].props;
    return expected;
  };

  const box123 = await getRichTextBoundingBox(page, "1");
  const inside123 = { x: box123.left + 1, y: box123.top + 1 };

  const box789 = await getRichTextBoundingBox(page, "6");
  const inside789 = { x: box789.right - 1, y: box789.bottom - 1 };
  // from top to bottom
  await dragBetweenCoords(page, inside123, inside789);

  await cutByKeyboard(page);
  await waitNextFrame(page);
  expect(JSON.parse(await getPageSnapshot(page, true))).toEqual(
    expectedSnapshot("cut"),
  );
  await waitNextFrame(page);
  await focusRichText(page);

  await pasteByKeyboard(page);
  await waitNextFrame(page);
  expect(JSON.parse(await getPageSnapshot(page, true))).toEqual(
    expectedSnapshot("paste"),
  );
});

test(`copy canvas element and text note in edgeless mode`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await initThreeParagraphs(page);
  await switchEditorMode(page);
  await createShapeElement(page, [0, 0], [100, 100]);
  await selectAllByKeyboard(page);
  const bound = await getEdgelessSelectedRectModel(page);
  await copyByKeyboard(page);
  const coord = await toViewCoord(page, [
    bound[0] + bound[2] / 2,
    bound[1] + bound[3] / 2 + 200,
  ]);
  await page.mouse.move(coord[0], coord[1]);
  await page.waitForTimeout(300);
  await pasteByKeyboard(page, false);
  bound[1] = bound[1] + 200;
  await assertEdgelessSelectedModelRect(page, bound);
});

test(scoped`copy when text note active in edgeless`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  const ids = await initEmptyEdgelessState(page);
  await focusRichText(page);
  await type(page, "1234");

  await switchEditorMode(page);

  await activeNoteInEdgeless(page, ids.noteId);
  await waitForInlineEditorStateUpdated(page);
  await focusRichText(page);
  await setInlineRangeInSelectedRichText(page, 0, 4);
  await copyByKeyboard(page);
  await pressArrowRight(page);
  await type(page, "555");
  await pasteByKeyboard(page, false);
  await assertText(page, "12345551234");
});

test(scoped`copy and paste to selection block selection`, async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/2265",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "1234");

  await selectAllByKeyboard(page);
  await copyByKeyboard(page);
  await pressArrowRight(page);
  await pasteByKeyboard(page, false);
  await waitNextFrame(page);
  await assertRichTexts(page, ["12341234"]);
});

test(
  scoped`should keep paragraph block's type when pasting at the start of empty paragraph block except type text`,
  async ({ page }) => {
    test.info().annotations.push({
      type: "issue",
      description: "https://github.com/example/virgultum/issues/2336",
    });
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await focusRichText(page);
    await type(page, ">");
    await page.keyboard.press("Space", { delay: 50 });

    // This owns quote preservation, not OS clipboard access in an HTTP fixture.
    await pasteContent(page, { "text/plain": "123" });
    await assertRichTexts(page, ["123"]);
    await assertBlockTypes(page, ["quote"]);

    await pressEnter(page);
    await waitNextFrame(page);
    await pressEnter(page);
    await waitNextFrame(page);
    await pasteContent(page, { "text/plain": "123" });
    await assertRichTexts(page, ["123", "123"]);
    await assertBlockTypes(page, ["quote", "text"]);
  },
);

test(scoped`paste from FeiShu list format`, async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/2438",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  // set up clipboard data using html
  const clipData = {
    "text/html": `<div><li><div><span>aaaa</span></div></li></div>`,
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
  await assertText(page, "aaaa");
  await assertBlockTypes(page, ["bulleted"]);
});

test(scoped`paste in list format`, async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/2281",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "- test");
  await focusRichText(page);

  const clipData = {
    "text/html": `<ul><li>111<ul><li>222</li></ul></li></ul>`,
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
  await assertRichTexts(page, ["test111", "222"]);
});
