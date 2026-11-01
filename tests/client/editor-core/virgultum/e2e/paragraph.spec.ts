import { expect, type Page } from "@playwright/test";

import {
  captureHistory,
  dragBetweenIndices,
  dragOverTitle,
  enterPlaygroundRoom,
  focusRichText,
  focusTitle,
  getBlockIds,
  getIndexCoordinate,
  getInlineSelectionIndex,
  getTextOperationSnapshot,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  initThreeDividers,
  initThreeParagraphs,
  pressArrowDown,
  pressArrowLeft,
  pressArrowUp,
  pressBackspace,
  pressBackspaceWithShortKey,
  pressEnter,
  pressForwardDelete,
  pressShiftEnter,
  pressShiftTab,
  pressTab,
  redoByKeyboard,
  resetHistory,
  setInlineRangeInSelectedRichText,
  setSelection,
  SHORT_KEY,
  switchReadonly,
  type,
  undoByKeyboard,
  updateBlockType,
  waitDefaultPageLoaded,
  waitNextFrame,
} from "./utils/actions/index.js";
import {
  assertBlockChildrenFlavours,
  assertBlockChildrenIds,
  assertBlockCount,
  assertBlockSelections,
  assertBlockTextContent,
  assertBlockType,
  assertClassName,
  assertDivider,
  assertDocTitleFocus,
  assertRichTextInlineRange,
  assertRichTexts,
  assertTitle,
} from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

type ParagraphSeed = {
  text: string;
  type?: "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  parentIndex?: number;
  collapsed?: boolean;
};

for (const flavour of ["myoxus:paragraph", "myoxus:list"]) {
  test(`repeat toolbar and split/merge keep one surviving ${flavour} prototype`, async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const { noteId, paragraphId } = await initEmptyParagraphState(page);
    const id = await page.evaluate(
      ({ flavour, noteId, paragraphId }) => {
        const { MyoxusHostServiceIdentifier } = window.$virgultum.services;
        const host = window.editor.std.get(MyoxusHostServiceIdentifier);
        host.isTemplateDocument = () => true;
        window.doc.deleteBlock(window.doc.getModelById(paragraphId)!);
        return window.doc.addBlock(
          flavour,
          {
            text: new window.$virgultum.store.Text("{{member.name}} tail"),
            ...(flavour === "myoxus:list"
              ? { type: "todo", checked: false }
              : {}),
          },
          noteId,
        );
      },
      { flavour, noteId, paragraphId },
    );
    await dragBetweenIndices(page, [0, 0], [0, 15]);
    await page.locator('editor-icon-button[aria-label="Repeat for"]').click();
    await page
      .locator("myoxus-menu-button")
      .filter({ hasText: "Workspace members" })
      .click();
    await expect(page.locator("myoxus-menu")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const props = window.doc.getModelById(id)!.props;
          return "repeat" in props ? props.repeat : undefined;
        }, id),
      )
      .toEqual({ source: "workspace.members", alias: "member" });
    // Page owns DOM focus at its editing root; the inner native range owns
    // the caret. Testing the nested contenteditable as activeElement is wrong.
    await expect(page.locator("myoxus-page-root")).toBeFocused();
    await dragBetweenIndices(page, [0, 15], [0, 15]);
    await assertRichTextInlineRange(page, 0, 15, 0);
    await pressEnter(page);
    await assertRichTexts(page, ["{{member.name}}", " tail"]);
    const bindings = () =>
      page.evaluate(
        (noteId) =>
          window.doc
            .getModelById(noteId)!
            .children.map((model) =>
              "repeat" in model.props ? (model.props.repeat ?? null) : null,
            ),
        noteId,
      );
    expect(await bindings()).toEqual([
      { source: "workspace.members", alias: "member" },
      null,
    ]);
    await pressBackspace(page);
    if (flavour === "myoxus:list") {
      // Native list Backspace first removes the list formatting; a second
      // Backspace merges the resulting paragraph into the surviving list.
      await assertBlockChildrenFlavours(page, noteId, [
        "myoxus:list",
        "myoxus:paragraph",
      ]);
      await pressBackspace(page);
    }
    await assertRichTexts(page, ["{{member.name}} tail"]);
    expect(await bindings()).toEqual([
      { source: "workspace.members", alias: "member" },
    ]);
    await dragBetweenIndices(page, [0, 0], [0, 15]);
    await page.locator('editor-icon-button[aria-label="Repeat for"]').click();
    await page
      .locator("myoxus-menu-button")
      .filter({ hasText: "Remove repeat" })
      .click();
    await expect.poll(bindings).toEqual([null]);
    await undoByKeyboard(page);
    expect(await bindings()).toEqual([
      { source: "workspace.members", alias: "member" },
    ]);
    await redoByKeyboard(page);
    expect(await bindings()).toEqual([null]);
    await assertRichTexts(page, ["{{member.name}} tail"]);
  });
}

test("eyebrow presentation preserves paragraph content and survivor semantics", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  const { noteId, paragraphId } = await initEmptyParagraphState(page);
  await page.evaluate((id) => {
    const model = window.doc.getModelById(id)!;
    window.doc.updateBlock(model, {
      text: new window.$virgultum.store.Text([
        { insert: "Agenda", attributes: { bold: true } },
        { insert: " label" },
      ]),
      textAlign: "center",
    });
  }, paragraphId);
  await waitNextFrame(page, 200);

  const paragraphState = () =>
    page.evaluate(
      (noteId) =>
        window.doc.getModelById(noteId)!.children.map((model) => ({
          text: model.props.text.toString(),
          delta: model.props.text.toDelta(),
          textAlign: model.props.textAlign,
          presentation: model.props.presentation ?? null,
        })),
      noteId,
    );
  const initial = await paragraphState();

  await dragBetweenIndices(page, [0, 0], [0, 12]);
  const eyebrow = page.locator('editor-icon-button[data-testid="eyebrow"]');
  await expect(eyebrow).toBeVisible();
  await eyebrow.click();
  await expect
    .poll(paragraphState)
    .toEqual([{ ...initial[0], presentation: "eyebrow" }]);
  await expect(
    page.locator(
      "myoxus-paragraph .myoxus-paragraph-rich-text-wrapper.eyebrow",
    ),
  ).toBeVisible();

  await switchReadonly(page);
  await expect(
    page.locator(
      "myoxus-paragraph .myoxus-paragraph-rich-text-wrapper.eyebrow",
    ),
  ).toBeVisible();
  await switchReadonly(page, false);

  await undoByKeyboard(page);
  await expect.poll(paragraphState).toEqual(initial);
  await redoByKeyboard(page);
  await expect
    .poll(paragraphState)
    .toEqual([{ ...initial[0], presentation: "eyebrow" }]);

  await focusRichText(page);
  await setInlineRangeInSelectedRichText(page, 6, 0);
  await pressEnter(page);
  await expect.poll(paragraphState).toEqual([
    {
      text: "Agenda",
      delta: [{ insert: "Agenda", attributes: { bold: true } }],
      textAlign: "center",
      presentation: "eyebrow",
    },
    {
      text: " label",
      delta: [{ insert: " label" }],
      presentation: null,
    },
  ]);
  await pressBackspace(page);
  await expect
    .poll(paragraphState)
    .toEqual([{ ...initial[0], presentation: "eyebrow" }]);

  await dragBetweenIndices(page, [0, 0], [0, 12]);
  await eyebrow.click();
  await expect.poll(paragraphState).toEqual(initial);
});

async function initParagraphSeed(page: Page, blocks: ParagraphSeed[]) {
  const ids = await page.evaluate((blocks) => {
    const { doc } = window;
    const Text = window.$virgultum.store.Text;
    doc.captureSync();
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new Text(),
      });
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    const ids: string[] = [];

    for (const block of blocks) {
      const parentId =
        block.parentIndex === undefined ? noteId : ids[block.parentIndex];
      if (!parentId) {
        throw new Error(`Missing parent for paragraph seed ${block.text}`);
      }
      ids.push(
        doc.addBlock(
          "myoxus:paragraph",
          {
            text: new Text(block.text),
            type: block.type ?? "text",
            collapsed: block.collapsed ?? false,
          },
          parentId,
        ),
      );
    }
    doc.captureSync();
    return ids;
  }, blocks);
  await waitNextFrame(page, 200);
  return ids;
}

async function expectParagraphModel(
  page: Page,
  index: number,
  expected: { text: string; type?: string },
) {
  await expect
    .poll(() =>
      page
        .locator("myoxus-paragraph")
        .nth(index)
        .evaluate((block) => {
          const model = (
            block as HTMLElement & {
              model?: {
                props?: { text?: { toString(): string }; type?: string };
              };
            }
          ).model;
          return {
            text: model?.props?.text?.toString() ?? "",
            type: model?.props?.type ?? "",
          };
        }),
    )
    .toMatchObject(expected);
}

async function expectParagraphVisible(
  page: Page,
  index: number,
  visible: boolean,
) {
  const paragraph = page.locator("myoxus-paragraph").nth(index);
  if (visible) {
    await expect(paragraph).toBeVisible();
  } else {
    await expect(paragraph).not.toBeVisible();
  }
}

async function clickHeadingToggle(page: Page, index: number) {
  const paragraph = page.locator("myoxus-paragraph").nth(index);
  await paragraph.hover();
  const toggle = paragraph.locator("virgultum-toggle-button .toggle-icon");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await waitNextFrame(page, 200);
}

async function expectNestedParagraphCount(
  page: Page,
  index: number,
  count: number,
) {
  await expect(
    page.locator("myoxus-paragraph").nth(index).locator("myoxus-paragraph"),
  ).toHaveCount(count);
}

test("init paragraph by page title enter at last", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await waitDefaultPageLoaded(page);
  await focusTitle(page);
  await type(page, "hello");
  await pressEnter(page);
  await type(page, "world");

  await assertTitle(page, "hello");
  await assertRichTexts(page, ["world", ""]);

  //#region Fixes: https://github.com/example/virgultum/issues/1007
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/1007",
  });
  await page.keyboard.press("ArrowLeft");
  await focusTitle(page);
  await pressEnter(page);
  await assertRichTexts(page, ["", "world", ""]);
  //#endregion
});

test("init paragraph by page title enter in middle", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await waitDefaultPageLoaded(page);
  await focusTitle(page);
  await type(page, "hello");
  await setInlineRangeInSelectedRichText(page, 2, 0);
  await pressEnter(page);

  await assertTitle(page, "he");
  await assertRichTexts(page, ["llo", ""]);
});

test("drag over paragraph title", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await waitDefaultPageLoaded(page);
  await focusTitle(page);
  await type(page, "hello");
  await assertTitle(page, "hello");
  await resetHistory(page);

  await dragOverTitle(page);
  await page.keyboard.press("Backspace", { delay: 100 });
  await assertTitle(page, "");

  await undoByKeyboard(page);
  await assertTitle(page, "hello");
});

for (const { initState, desc } of [
  {
    initState: initEmptyParagraphState,
    desc: "without surface",
  },
  {
    initState: initEmptyEdgelessState,
    desc: "with surface",
  },
]) {
  test(`backspace on line start of the first block (${desc})`, async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initState(page);
    await waitDefaultPageLoaded(page);
    await focusTitle(page);
    await type(page, "hello");
    await assertTitle(page, "hello");
    await resetHistory(page);

    await focusRichText(page, 0);
    await type(page, "abc");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(300);
    await assertRichTextInlineRange(page, 0, 0, 0);

    await pressBackspace(page);
    await assertTitle(page, "helloabc");

    await pressEnter(page);
    await assertTitle(page, "hello");
    await assertRichTexts(page, ["abc", ""]);

    await pressBackspace(page);
    await assertTitle(page, "helloabc");
    await assertRichTexts(page, [""]);
    await undoByKeyboard(page);
    await assertTitle(page, "hello");
    await assertRichTexts(page, ["abc", ""]);

    await redoByKeyboard(page);
    await assertTitle(page, "helloabc");
    await assertRichTexts(page, [""]);
  });

  test(`backspace on line start of the first empty block (${desc})`, async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initState(page);
    await focusTitle(page);

    await pressArrowDown(page);
    await pressBackspace(page);
    await assertBlockCount(page, "paragraph", 1);

    await pressArrowDown(page);
    await assertRichTextInlineRange(page, 0, 0, 0);
  });
}

test("append new paragraph block by enter", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");
  await assertRichTextInlineRange(page, 0, 5, 0);

  await pressEnter(page);
  await assertRichTexts(page, ["hello", ""]);
  await assertRichTextInlineRange(page, 1, 0, 0);

  await undoByKeyboard(page);
  await waitNextFrame(page);
  await assertRichTexts(page, ["hello"]);
  await assertRichTextInlineRange(page, 0, 5, 0);

  await redoByKeyboard(page);
  await waitNextFrame(page);
  await assertRichTexts(page, ["hello", ""]);
  await assertRichTextInlineRange(page, 1, 0, 0);
});

test("insert new paragraph block by enter", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await pressEnter(page);
  await pressEnter(page);
  await assertRichTexts(page, ["", "", ""]);

  await focusRichText(page, 1);
  await type(page, "hello");
  await assertRichTexts(page, ["", "hello", ""]);

  await pressEnter(page);
  await type(page, "world");
  await assertRichTexts(page, ["", "hello", "world", ""]);
  await assertBlockChildrenFlavours(page, "1", [
    "myoxus:paragraph",
    "myoxus:paragraph",
    "myoxus:paragraph",
    "myoxus:paragraph",
  ]);
});

test("split paragraph block by enter", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "hello");
  await assertRichTexts(page, ["hello"]);

  await pressArrowLeft(page, 3);
  await page.waitForTimeout(300);
  await assertRichTextInlineRange(page, 0, 2, 0);

  await pressEnter(page);
  await assertRichTexts(page, ["he", "llo"]);
  await assertBlockChildrenFlavours(page, "1", [
    "myoxus:paragraph",
    "myoxus:paragraph",
  ]);
  await assertRichTextInlineRange(page, 1, 0, 0);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["hello"]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["he", "llo"]);
});

test("split paragraph block with selected text by enter", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "hello");
  await assertRichTexts(page, ["hello"]);
  // Avoid Yjs history manager merge two operations
  await captureHistory(page);

  // select 'll'
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.down("Shift");
  await page.waitForTimeout(100);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  await page.keyboard.up("Shift");
  await assertRichTextInlineRange(page, 0, 2, 2);

  await pressEnter(page);
  await assertRichTexts(page, ["he", "o"]);
  await assertBlockChildrenFlavours(page, "1", [
    "myoxus:paragraph",
    "myoxus:paragraph",
  ]);
  await assertRichTextInlineRange(page, 1, 0, 0);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["hello"]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["he", "o"]);
});

test("add multi line by soft enter", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "hello");
  await assertRichTexts(page, ["hello"]);

  await pressArrowLeft(page, 3);
  await assertRichTextInlineRange(page, 0, 2, 0);
  // Avoid Yjs history manager merge two operations
  await captureHistory(page);

  await pressShiftEnter(page);
  await assertRichTexts(page, ["he\nllo"]);
  await assertRichTextInlineRange(page, 0, 3, 0);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["hello"]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["he\nllo"]);
});

test("indent and unindent existing paragraph block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");

  await pressEnter(page);
  await focusRichText(page, 1);
  await type(page, "world");
  await assertRichTexts(page, ["hello", "world"]);

  // indent
  await page.keyboard.press("Tab");
  await assertRichTexts(page, ["hello", "world"]);
  await assertBlockChildrenIds(page, "1", ["2"]);
  await assertBlockChildrenIds(page, "2", ["3"]);

  // unindent
  await pressShiftTab(page);
  await assertRichTexts(page, ["hello", "world"]);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);

  await undoByKeyboard(page);
  await assertBlockChildrenIds(page, "1", ["2"]);

  await redoByKeyboard(page);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);
});

test("remove all indent for a paragraph block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "world");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "foo");
  await assertBlockChildrenIds(page, "3", ["4"]);
  await assertRichTexts(page, ["hello", "world", "foo"]);
  await pressBackspaceWithShortKey(page);
  await assertRichTexts(page, ["hello", "world", ""]);
  await pressBackspaceWithShortKey(page);
  await assertBlockChildrenIds(page, "1", ["2", "4"]);
  await assertBlockChildrenIds(page, "2", ["3"]);
});

test("update paragraph with children to head type", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaa");

  await pressEnter(page);
  await focusRichText(page, 1);
  await type(page, "bbb");
  await pressEnter(page);
  await focusRichText(page, 2);
  await type(page, "ccc");
  await assertRichTexts(page, ["aaa", "bbb", "ccc"]);

  // aaa
  //   bbc
  //   ccc
  await focusRichText(page, 1);
  await page.keyboard.press("Tab");
  await focusRichText(page, 2);
  await page.keyboard.press("Tab");
  await assertRichTexts(page, ["aaa", "bbb", "ccc"]);
  await assertBlockChildrenIds(page, "1", ["2"]);
  await assertBlockChildrenIds(page, "2", ["3", "4"]);

  await focusRichText(page);
  await pressArrowLeft(page, 3);

  await type(page, "# ");

  await assertRichTexts(page, ["aaa", "bbb", "ccc"]);
  await assertBlockChildrenIds(page, "2", ["3", "4"]);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["# aaa", "bbb", "ccc"]);
  await assertBlockChildrenIds(page, "1", ["2"]);
  await assertBlockChildrenIds(page, "2", ["3", "4"]);

  await redoByKeyboard(page);
  await assertRichTexts(page, ["aaa", "bbb", "ccc"]);
  await assertBlockChildrenIds(page, "2", ["3", "4"]);
});

test("should indent and unindent works with children", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await pressEnter(page);
  await type(page, "012");
  await pressEnter(page);
  await type(page, "345");
  // 123
  // 456
  // 789
  // 012
  // 345

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );
  //-- test indent --//

  // Focus 789
  await focusRichText(page, 2);
  await pressTab(page);
  // 123
  // 456
  //   789|
  // 012
  // 345

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_indent.json`,
  );

  // Focus 012
  await focusRichText(page, 3);
  await pressTab(page);
  // 123
  // 456
  //   789
  //   012|
  // 345

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_indent_2.json`,
  );

  // Focus 456
  await focusRichText(page, 1);
  await pressTab(page);
  // 123
  //   456|
  //     789
  //     012
  // 345

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_indent_3.json`,
  );

  // Focus 345
  await focusRichText(page, 4);
  await pressTab(page, 3);
  // 123
  //   456
  //     789
  //     012
  //       345|

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_indent_4.json`,
  );
  //-- test unindent --//

  // Focus 456
  await focusRichText(page, 1);
  await pressShiftTab(page);
  // 123
  // 456|
  //   789
  //   012
  //     345

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_unindent_1.json`,
  );

  // Focus 012
  await focusRichText(page, 3);
  await pressShiftTab(page);
  // 123
  // 456
  //   789
  // 012|
  //   345

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_unindent_2.json`,
  );

  // Focus 789
  await focusRichText(page, 2);
  await pressShiftTab(page);
  // 123
  // 456
  // 789|
  // 012
  //   345

  // Focus 345
  await focusRichText(page, 4);
  await pressShiftTab(page);
  // 123
  // 456
  // 789
  // 012
  // 345|

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_unindent_3.json`,
  );
});

test("paragraph with child block should work at enter", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "123");
  await pressEnter(page);
  await type(page, "456");

  await focusRichText(page, 1);
  await page.keyboard.press("Tab");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );
  await focusRichText(page, 0);
  await pressEnter(page);
  await type(page, "789");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_final.json`,
  );
});

test("should delete paragraph block child can hold cursor in correct position", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "123");
  await pressEnter(page);
  await pressTab(page);
  await waitNextFrame(page);
  await type(page, "4");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await pressBackspace(page, 2);
  await waitNextFrame(page);
  await type(page, "now");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_final.json`,
  );
});

test("switch between paragraph types", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");

  const selector = ".myoxus-paragraph-rich-text-wrapper";

  await updateBlockType(page, "myoxus:paragraph", "h1");
  await assertClassName(page, selector, /h1/);

  await updateBlockType(page, "myoxus:paragraph", "h2");
  await assertClassName(page, selector, /h2/);

  await updateBlockType(page, "myoxus:paragraph", "h3");
  await assertClassName(page, selector, /h3/);

  await undoByKeyboard(page);
  await assertClassName(page, selector, /h2/);

  await undoByKeyboard(page);
  await assertClassName(page, selector, /h1/);
});

test("delete at start of paragraph block", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");

  await pressEnter(page);
  await type(page, "a");

  await updateBlockType(page, "myoxus:paragraph", "h1");
  await focusRichText(page, 1);
  await assertBlockType(page, "2", "text");
  await assertBlockType(page, "3", "h1");

  await pressBackspace(page);
  await pressBackspace(page);
  await assertBlockType(page, "3", "text");
  await assertBlockChildrenIds(page, "1", ["2", "3"]);

  await page.keyboard.press("Backspace");
  await assertBlockChildrenIds(page, "1", ["2"]);

  await undoByKeyboard(page);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);
});

test("delete at start of paragraph immediately following list", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");

  await pressEnter(page);
  await type(page, "a");

  await captureHistory(page);

  await assertRichTexts(page, ["hello", "a"]);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);
  await assertBlockType(page, "3", "text");

  // text -> bulleted
  await focusRichText(page, 1);
  await updateBlockType(page, "myoxus:list", "bulleted");
  await assertBlockType(page, "2", "text");
  await assertBlockType(page, "4", "bulleted");
  await pressBackspace(page, 2);
  await waitNextFrame(page);
  await assertBlockType(page, "5", "text");
  await assertBlockChildrenIds(page, "1", ["2", "5"]);
  await pressBackspace(page);
  await assertBlockChildrenIds(page, "1", ["2"]);

  // reset
  await undoByKeyboard(page);
  await undoByKeyboard(page);
  await assertRichTexts(page, ["hello", "a"]);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);
  await assertBlockType(page, "3", "text");

  // text -> numbered
  await focusRichText(page, 1);
  await updateBlockType(page, "myoxus:list", "numbered");
  await assertBlockType(page, "2", "text");
  await assertBlockType(page, "6", "numbered");
  await pressBackspace(page, 2);
  await waitNextFrame(page);
  await assertBlockType(page, "7", "text");
  await assertBlockChildrenIds(page, "1", ["2", "7"]);
  await pressBackspace(page);
  await assertBlockChildrenIds(page, "1", ["2"]);

  // reset
  await undoByKeyboard(page);
  await undoByKeyboard(page);
  await assertRichTexts(page, ["hello", "a"]);
  await assertBlockChildrenIds(page, "1", ["2", "3"]);
  await assertBlockType(page, "3", "text");

  // text -> todo
  await focusRichText(page, 1);
  await updateBlockType(page, "myoxus:list", "todo");
  await assertBlockType(page, "2", "text");
  await assertBlockType(page, "8", "todo");
  await pressBackspace(page, 2);
  await waitNextFrame(page);
  await assertBlockType(page, "9", "text");
  await assertBlockChildrenIds(page, "1", ["2", "9"]);
  await pressBackspace(page);
  await assertBlockChildrenIds(page, "1", ["2"]);
});

test("delete at start of paragraph with content", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "123");

  await pressEnter(page);
  await type(page, "456");
  await assertRichTexts(page, ["123", "456"]);

  await captureHistory(page);

  await pressArrowLeft(page, 3);
  await assertRichTextInlineRange(page, 1, 0, 0);

  await pressBackspace(page);
  await assertRichTexts(page, ["123456"]);

  await undoByKeyboard(page);
  await assertRichTexts(page, ["123", "456"]);
});

test("delete empty line should work correctly", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  // 2: aaa
  // 3:     bbb
  // 4: ccc|
  {
    await type(page, "aaa");
    await pressEnter(page);
    await pressTab(page);
    await type(page, "bbb");
    await pressEnter(page);
    await pressShiftTab(page);
    await type(page, "ccc");
  }

  // 2: aaa
  // 3:     bbb|
  await pressBackspace(page, 4);
  expect(await getBlockIds(page)).not.toContain(4);
  await assertBlockTextContent(page, 2, "aaa");
  await assertBlockTextContent(page, 3, "bbb");
  expect(await getInlineSelectionIndex(page)).toBe(3);

  // title: |aaa
  // 3: bbb
  {
    await pressArrowUp(page);
    await pressArrowLeft(page, 3);
    await pressBackspace(page);
  }
  await expect(page.locator("doc-title")).toContainText("aaa");
  expect(await getBlockIds(page)).not.toContain(2);
  await assertBlockTextContent(page, 3, "bbb");
  expect(await getInlineSelectionIndex(page)).toBe(0);
});

test("handling keyup when cursor located in first paragraph", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusTitle(page);
  await type(page, "hello");
  await assertRichTexts(page, [""]);

  await pressEnter(page);
  await type(page, "world");
  await assertRichTexts(page, ["world", ""]);
  await pressArrowUp(page);
  await waitNextFrame(page);
  await pressArrowUp(page);
  await assertDocTitleFocus(page);
});

test("after deleting a text row, cursor should jump to the end of previous list row", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");
  await assertRichTextInlineRange(page, 0, 5, 0);

  await pressEnter(page);
  await type(page, "w");
  await assertRichTexts(page, ["hello", "w"]);
  await assertRichTextInlineRange(page, 1, 1, 0);
  await pressArrowUp(page);
  await pressArrowDown(page);

  await pressArrowLeft(page);
  await pressBackspace(page);
  await assertRichTextInlineRange(page, 0, 5, 0);
});

test("press tab in paragraph children", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await waitDefaultPageLoaded(page);
  await focusTitle(page);
  await pressEnter(page);
  await type(page, "1");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "2");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "3");
  await page.keyboard.press("ArrowUp", { delay: 50 });
  await page.keyboard.press("ArrowLeft", { delay: 50 });
  await type(page, "- ");
  await assertRichTexts(page, ["1", "2", "3", ""]);
});

test("press left in first paragraph start should not change cursor position", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "1");

  await pressArrowLeft(page, 2);
  await type(page, "l");
  await assertRichTexts(page, ["l1"]);
  await assertTitle(page, "");
});

test("press arrow down should move caret to the start of line", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await page.evaluate(() => {
    const { doc } = window;
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    const note = doc.addBlock("myoxus:note", {}, rootId);
    doc.addBlock(
      "myoxus:paragraph",
      {
        text: new window.$virgultum.store.Text("0".repeat(100)),
      },
      note,
    );
    doc.addBlock(
      "myoxus:paragraph",
      {
        text: new window.$virgultum.store.Text("1"),
      },
      note,
    );
  });

  // Focus the empty child paragraph
  await focusRichText(page, 1);
  await pressArrowLeft(page);
  await pressArrowUp(page);
  await pressArrowDown(page);
  await type(page, "2");
  await assertRichTexts(page, ["0".repeat(100), "21"]);
});

test("should placeholder works", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  const placeholder = page.locator(".myoxus-paragraph-placeholder.visible");
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText("Type '/' for commands");

  await type(page, "1");
  await expect(placeholder).not.toBeVisible();
  await pressBackspace(page);

  await expect(placeholder).toBeVisible();
  await updateBlockType(page, "myoxus:paragraph", "h1");

  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveText("Heading 1");
  await updateBlockType(page, "myoxus:paragraph", "text");
  await focusRichText(page, 0);
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toContainText("Type '/' for commands");

  await pressEnter(page);
  await expect(placeholder).toHaveCount(1);
});

test("should placeholder not show when multiple blocks are selected", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await pressEnter(page);
  await assertRichTexts(page, ["", ""]);
  const coord = await getIndexCoordinate(page, [0, 0]);
  // blur
  await page.mouse.click(0, 0);
  await page.mouse.move(coord.x - 26 - 24, coord.y - 10, { steps: 20 });
  await page.mouse.down();
  // ←
  await page.mouse.move(coord.x + 20, coord.y + 50, { steps: 20 });
  await page.mouse.up();
  const placeholder = page.locator(".myoxus-paragraph-placeholder.visible");
  await expect(placeholder).toBeHidden();
});

test.describe("press ArrowDown when cursor is at the last line of a block", () => {
  test.beforeEach(async ({ page }) => {
    await enterPlaygroundRoom(page);
    await page.evaluate(() => {
      const { doc } = window;
      const rootId =
        doc.root?.id ??
        doc.addBlock("myoxus:page", {
          title: new window.$virgultum.store.Text(),
        });
      const note = doc.addBlock("myoxus:note", {}, rootId);
      doc.addBlock(
        "myoxus:paragraph",
        {
          text: new window.$virgultum.store.Text("This is the 2nd last block."),
        },
        note,
      );
      doc.addBlock(
        "myoxus:paragraph",
        {
          text: new window.$virgultum.store.Text("This is the last block."),
        },
        note,
      );
    });
  });

  test("move cursor to next block if this block is _not_ the last block in the page", async ({
    page,
  }) => {
    // Click at the top-left corner of the 2nd last block to place the cursor at its start
    await focusRichText(page, 0, { clickPosition: { x: 0, y: 0 } });
    // Cursor should have been moved to the start of the last block.
    await pressArrowDown(page);
    await type(page, "I'm here. ");
    await assertRichTexts(page, [
      "This is the 2nd last block.",
      "I'm here. This is the last block.",
    ]);
  });
});

test("delete empty text paragraph block should keep children blocks when following custom blocks", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "--- ");
  await assertDivider(page, 1);

  // Click blank area to add a paragraph block after divider
  await page.mouse.click(100, 200);
  await page.waitForTimeout(200);

  // Add to paragraph blocks
  await initThreeParagraphs(page);
  await assertRichTexts(page, ["123", "456", "789"]);

  // Indent the second paragraph block
  await focusRichText(page, 2);
  await pressTab(page);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  // Delete the parent paragraph block
  await focusRichText(page, 1);
  await pressBackspace(page, 4);

  await assertRichTexts(page, ["123", "789"]);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_final.json`,
  );
});

test("delete first paragraph with children should keep children blocks", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "123");
  await pressEnter(page);
  await pressTab(page);
  await waitNextFrame(page);
  await type(page, "456");
  await setSelection(page, 2, 1, 2, 1);
  await pressBackspace(page, 2);
  await waitNextFrame(page);
  await assertTitle(page, "23");
  await assertRichTexts(page, ["456"]);
});

test("paragraph indent and delete in line start", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "abc");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "efg");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "hij");
  await pressEnter(page);
  await pressShiftTab(page);
  await type(page, "klm");
  await pressEnter(page);
  await type(page, "nop");
  await setSelection(page, 3, 1, 3, 1);
  // abc
  //   e|fg
  //     hij
  //   klm
  //   nop

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await pressBackspace(page, 2);
  await setSelection(page, 5, 1, 5, 1);
  // abcfg
  //   hij
  //   k|lm
  //   nop

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_after_press_backspace.json`,
  );

  await pressBackspace(page, 2);
  await setSelection(page, 6, 1, 6, 1);
  // abcfg
  //   hijlm
  //   n|op

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_after_press_backspace_2.json`,
  );

  await pressBackspace(page, 2);
  // abcfg
  //   hijlm
  // |op

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_after_press_backspace_3.json`,
  );
});

test("delete at the start of paragraph (multiple notes)", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await page.evaluate(() => {
    const { doc } = window;

    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    doc.addBlock("myoxus:surface", {}, rootId);

    ["123", "456"].forEach((text) => {
      const noteId = doc.addBlock("myoxus:note", {}, rootId);
      doc.addBlock(
        "myoxus:paragraph",
        {
          text: new window.$virgultum.store.Text(text),
        },
        noteId,
      );
    });

    doc.resetHistory();
  });

  await assertBlockCount(page, "note", 2);

  await assertRichTexts(page, ["123", "456"]);
  await focusRichText(page, 1);
  await pressArrowLeft(page, 3);
  await pressBackspace(page);
  await assertRichTexts(page, ["123456"]);
});

test("select divider using delete keyboard from prev/next paragraph", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/4547",
  });

  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await initThreeDividers(page);
  await assertDivider(page, 3);
  await assertRichTexts(page, ["123", "123"]);

  await focusRichText(page, 0);
  await pressForwardDelete(page);
  await assertBlockSelections(page, ["4"]);
  await assertDivider(page, 3);

  await focusRichText(page, 1);
  await pressArrowLeft(page, 3);
  await pressBackspace(page);
  await assertBlockSelections(page, ["6"]);
  await assertDivider(page, 3);

  await assertRichTexts(page, ["123", "123"]);
});

test.describe("readonly mode", () => {
  test("should placeholder not show at readonly mode", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await pressEnter(page);
    await updateBlockType(page, "myoxus:paragraph", "h1");

    const placeholder = page.locator(".myoxus-paragraph-placeholder.visible");

    await switchReadonly(page);
    await focusRichText(page, 0);
    await expect(placeholder).toBeHidden();

    await focusRichText(page, 1);
    await expect(placeholder).toBeHidden();
  });

  test("should readonly mode not be able to modify text", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);

    await focusRichText(page);
    await type(page, "hello");
    await switchReadonly(page);

    await pressBackspace(page, 5);
    await type(page, "world");
    await dragBetweenIndices(page, [0, 1], [0, 3]);
    await page.keyboard.press(`${SHORT_KEY}+b`);
    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}_1.json`,
    );

    await undoByKeyboard(page);
    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}_2.json`,
    );
  });
});

test.describe("heading collapse ownership", () => {
  test("heading icon follows the current paragraph heading level", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const [paragraphId] = await initParagraphSeed(page, [{ text: "Hello" }]);
    await setSelection(page, Number(paragraphId), 0, Number(paragraphId), 5);

    await updateBlockType(page, "myoxus:paragraph", "h1");
    const paragraph = page.locator("myoxus-paragraph").nth(0);
    await paragraph.hover();
    await expect(page.getByTestId("heading-icon-1")).toBeVisible();

    await updateBlockType(page, "myoxus:paragraph", "h2");
    await paragraph.hover();
    await expect(page.getByTestId("heading-icon-1")).toBeHidden();
    await expect(page.getByTestId("heading-icon-2")).toBeVisible();
  });

  test("heading collapse hides lower-level siblings until the next peer heading", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initParagraphSeed(page, [
      { text: "aaa", type: "h1" },
      { text: "bbb" },
      { text: "ccc", type: "h2" },
      { text: "ddd" },
      { text: "eee", type: "h3" },
      { text: "fff" },
      { text: "ggg", type: "h2" },
      { text: "hhh" },
      { text: "iii", type: "h1" },
      { text: "jjj" },
    ]);

    for (let i = 0; i < 10; i++) {
      await expectParagraphVisible(page, i, true);
    }

    await clickHeadingToggle(page, 0);
    await expectParagraphVisible(page, 0, true);
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      await expectParagraphVisible(page, index, false);
    }
    await expectParagraphVisible(page, 8, true);
    await expectParagraphVisible(page, 9, true);
    await clickHeadingToggle(page, 0);

    await clickHeadingToggle(page, 2);
    for (const index of [0, 1, 2, 6, 7, 8, 9]) {
      await expectParagraphVisible(page, index, true);
    }
    for (const index of [3, 4, 5]) {
      await expectParagraphVisible(page, index, false);
    }
    await clickHeadingToggle(page, 2);

    await clickHeadingToggle(page, 4);
    for (const index of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
      await expectParagraphVisible(page, index, true);
    }
    await expectParagraphVisible(page, 5, false);
    await clickHeadingToggle(page, 4);

    await clickHeadingToggle(page, 6);
    for (const index of [0, 1, 2, 3, 4, 5, 6, 8, 9]) {
      await expectParagraphVisible(page, index, true);
    }
    await expectParagraphVisible(page, 7, false);
  });

  test("enter at a collapsed heading creates the expected paragraph or heading", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const ids = await initParagraphSeed(page, [
      { text: "aaa", type: "h1" },
      { text: "bbb" },
    ]);
    const headingId = Number(ids[0]);

    await setSelection(page, headingId, 3, headingId, 3);
    await pressEnter(page);
    await expectParagraphModel(page, 1, { text: "", type: "text" });
    await expectParagraphModel(page, 2, { text: "bbb" });

    await undoByKeyboard(page);
    await clickHeadingToggle(page, 0);
    await setSelection(page, headingId, 3, headingId, 3);
    await pressEnter(page);
    await expectParagraphModel(page, 2, { text: "", type: "h1" });
  });

  test("indent and type conversion expand a previous collapsed heading", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const ids = await initParagraphSeed(page, [
      { text: "aaa", type: "h1", collapsed: true },
      { text: "bbb" },
      { text: "ccc", type: "h1" },
    ]);
    await expectParagraphVisible(page, 1, false);

    await setSelection(page, Number(ids[2]), 0, Number(ids[2]), 0);
    await pressTab(page);
    await expectParagraphVisible(page, 1, true);

    await undoByKeyboard(page);
    await clickHeadingToggle(page, 0);
    await setSelection(page, Number(ids[2]), 0, Number(ids[2]), 0);
    await updateBlockType(page, "myoxus:paragraph", "text");
    await expectParagraphModel(page, 2, { text: "ccc", type: "text" });
    await expectParagraphVisible(page, 1, true);
  });

  test("dedenting a collapsed heading moves its hidden children with it", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const ids = await initParagraphSeed(page, [
      { text: "aaa" },
      { text: "bbb", type: "h1", parentIndex: 0, collapsed: true },
      { text: "ccc", parentIndex: 0 },
    ]);
    await expectNestedParagraphCount(page, 0, 2);
    await expectParagraphVisible(page, 2, false);

    await setSelection(page, Number(ids[1]), 0, Number(ids[1]), 0);
    await pressShiftTab(page);

    await expectNestedParagraphCount(page, 0, 0);
    await expectParagraphModel(page, 1, { text: "bbb", type: "h1" });
    await expectParagraphModel(page, 2, { text: "ccc", type: "text" });
    await expectParagraphVisible(page, 2, false);

    await clickHeadingToggle(page, 1);
    await expectParagraphVisible(page, 2, true);
  });

  test("indenting a collapsed heading moves its collapsed siblings with it", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const ids = await initParagraphSeed(page, [
      { text: "aaa" },
      { text: "bbb", type: "h1", collapsed: true },
      { text: "ccc" },
    ]);
    await expectNestedParagraphCount(page, 0, 0);
    await expectParagraphVisible(page, 2, false);

    await setSelection(page, Number(ids[1]), 0, Number(ids[1]), 0);
    await pressTab(page);

    await expectNestedParagraphCount(page, 0, 2);
    await expectParagraphModel(page, 1, { text: "bbb", type: "h1" });
    await expectParagraphModel(page, 2, { text: "ccc", type: "text" });
    await expectParagraphVisible(page, 2, false);
  });

  test("indenting another block into a collapsed heading group reveals hidden siblings", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    const ids = await initParagraphSeed(page, [
      { text: "aaa" },
      { text: "bbb", type: "h1", parentIndex: 0, collapsed: true },
      { text: "ccc", parentIndex: 0 },
      { text: "ddd" },
    ]);
    await expectParagraphVisible(page, 2, false);
    await expectNestedParagraphCount(page, 0, 2);

    await setSelection(page, Number(ids[3]), 0, Number(ids[3]), 0);
    await pressTab(page);

    await expectNestedParagraphCount(page, 0, 3);
    await expectParagraphVisible(page, 2, true);
  });
});
