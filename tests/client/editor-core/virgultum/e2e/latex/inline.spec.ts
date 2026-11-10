import { expect, type Locator } from "@playwright/test";

import {
  pressArrowLeft,
  pressArrowRight,
  pressArrowUp,
  pressBackspace,
  pressBackspaceWithShortKey,
  pressEnter,
  pressShiftEnter,
  redoByKeyboard,
  selectAllByKeyboard,
  type,
  undoByKeyboard,
} from "../utils/actions/keyboard.js";
import {
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
} from "../utils/actions/misc.js";
import {
  assertRichTextInlineDeltas,
  assertRichTextInlineRange,
} from "../utils/asserts.js";
import { ZERO_WIDTH_FOR_EMPTY_LINE } from "../utils/inline-editor.js";
import { test } from "../utils/playwright.js";
import { switchReadonly } from "../utils/actions/click.js";

async function assertRenderedEquation(element: Locator, source: string) {
  // Own the editor-to-renderer handoff, not KaTeX's formatted implementation HTML.
  await expect(element.locator(".katex-mathml annotation")).toHaveText(source);
  await expect(element.locator(".katex-html")).toBeVisible();
  await expect(element.locator(".katex-error")).toHaveCount(0);
}

test("add inline latex at the start of line", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const latexEditorLine = page.locator("latex-source-editor v-line div");
  const latexElement = page.locator(
    "myoxus-paragraph rich-text myoxus-latex-node",
  );

  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  expect(await latexElement.isVisible()).not.toBeTruthy();
  await type(page, "$$ ");
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  expect(await latexElement.isVisible()).toBeTruthy();
  expect(await latexElement.locator(".placeholder").innerText()).toBe(
    "Equation",
  );
  await type(page, "E=mc^2");
  expect(await latexEditorLine.innerText()).toBe("E=mc^2");
  const innerHTML = await latexElement.locator(".katex").innerHTML();
  await assertRenderedEquation(latexElement, "E=mc^2");

  await pressEnter(page);
  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  expect(await latexElement.locator(".katex").innerHTML()).toBe(innerHTML);
});

test("add inline latex in the middle of text", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const latexEditorLine = page.locator("latex-source-editor v-line div");
  const latexElement = page.locator(
    "myoxus-paragraph rich-text myoxus-latex-node",
  );

  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  expect(await latexElement.isVisible()).not.toBeTruthy();
  await type(page, "aaaa");
  await pressArrowLeft(page, 2);
  await type(page, "$$ ");
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  expect(await latexElement.isVisible()).toBeTruthy();
  expect(await latexElement.locator(".placeholder").innerText()).toBe(
    "Equation",
  );
  await type(page, "E=mc^2");
  expect(await latexEditorLine.innerText()).toBe("E=mc^2");

  const innerHTML = await latexElement.locator(".katex").innerHTML();
  await assertRenderedEquation(latexElement, "E=mc^2");

  await pressEnter(page);
  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  expect(await latexElement.locator(".katex").innerHTML()).toBe(innerHTML);
});

test("update inline latex by clicking the node", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const latexEditorLine = page.locator("latex-source-editor v-line div");
  const latexElement = page.locator(
    "myoxus-paragraph rich-text myoxus-latex-node",
  );

  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  await type(page, "$$ ");
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  await type(page, "E=mc^2");
  await pressEnter(page);
  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  await latexElement.click();
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  await pressBackspace(page, 6);
  await type(page, String.raw`\def\arraystretch{1.5}`);
  await pressShiftEnter(page);
  await type(page, String.raw`\begin{array}{c:c:c}`);
  await pressShiftEnter(page);
  await type(page, String.raw`a & b & c \\ \\ hline`);
  await pressShiftEnter(page);
  await type(page, String.raw`d & e & f \\`);
  await pressShiftEnter(page);
  await type(page, String.raw`\hdashline`);
  await pressShiftEnter(page);
  await type(page, String.raw`g & h & i`);
  await pressShiftEnter(page);
  await type(page, String.raw`\end{array}`);

  const editedSource = String.raw`\def\arraystretch{1.5}
\begin{array}{c:c:c}
a & b & c \\ \\ hline
d & e & f \\
\hdashline
g & h & i
\end{array}`;
  await assertRenderedEquation(latexElement, editedSource);

  await page.keyboard.press("Escape");
  await undoByKeyboard(page);
  await assertRenderedEquation(latexElement, "E=mc^2");
  await latexElement.click();
  expect(await latexEditorLine.innerText()).toBe("E=mc^2");
  await page.keyboard.press("Escape");
  await redoByKeyboard(page);
  await assertRenderedEquation(latexElement, editedSource);
  await latexElement.click();
  await page.locator("latex-source-editor [contenteditable=true]").click();
  await selectAllByKeyboard(page);
  await type(page, String.raw`\notACommand`);
  await switchReadonly(page);
  await expect(latexEditorLine).not.toBeVisible();
  await assertRenderedEquation(latexElement, editedSource);
  await switchReadonly(page, false);
  await latexElement.click();
  await page.locator("latex-source-editor").waitFor();
  // Keep click-away separate: clicking blank Page space also appends a paragraph.
  await page.click("myoxus-editor-container");
  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
});

test("latex editor", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const latexEditorLine = page.locator("latex-source-editor v-line div");
  const latexElement = page.locator(
    "myoxus-paragraph rich-text myoxus-latex-node",
  );

  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  await type(page, "$$ ");
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  // test cursor movement works as expected
  // https://github.com/example/virgultum/pull/8368
  await type(page, "ababababababababababababababababababababababababab");
  expect(await latexEditorLine.innerText()).toBe(
    "ababababababababababababababababababababababababab",
  );
  // click outside to hide the editor
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  await page.locator("myoxus-editor-container").click();
  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  await latexElement.click();
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  expect(await latexEditorLine.innerText()).toBe(
    "ababababababababababababababababababababababababab",
  );

  await pressBackspaceWithShortKey(page, 2);
  expect(await latexEditorLine.innerText()).toBe(ZERO_WIDTH_FOR_EMPTY_LINE);
  await undoByKeyboard(page);
  expect(await latexEditorLine.innerText()).toBe(
    "ababababababababababababababababababababababababab",
  );
  await redoByKeyboard(page);
  expect(await latexEditorLine.innerText()).toBe(ZERO_WIDTH_FOR_EMPTY_LINE);
  await undoByKeyboard(page);
  expect(await latexEditorLine.innerText()).toBe(
    "ababababababababababababababababababababababababab",
  );

  await selectAllByKeyboard(page);
  await pressBackspace(page);
  expect(await latexEditorLine.innerText()).toBe(ZERO_WIDTH_FOR_EMPTY_LINE);
  await type(page, "old");
  await page
    .locator("latex-source-editor [contenteditable=true]")
    .evaluate((element) => {
      // Native selection can change before the queued selectionchange projection.
      element.ownerDocument.getSelection()!.selectAllChildren(element);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "E=mc^2");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    });
  expect(await latexEditorLine.innerText()).toBe("E=mc^2");
});

test("add inline latex using slash menu", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  const latexEditorLine = page.locator("latex-source-editor v-line div");
  const latexElement = page.locator(
    "myoxus-paragraph rich-text myoxus-latex-node",
  );

  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  expect(await latexElement.isVisible()).not.toBeTruthy();
  await type(page, "/ieq\n");
  expect(await latexEditorLine.isVisible()).toBeTruthy();
  expect(await latexElement.isVisible()).toBeTruthy();
  expect(await latexElement.locator(".placeholder").innerText()).toBe(
    "Equation",
  );
  await type(page, "E=mc^2");
  expect(await latexEditorLine.innerText()).toBe("E=mc^2");
  const innerHTML = await latexElement.locator(".katex").innerHTML();
  await assertRenderedEquation(latexElement, "E=mc^2");

  await pressEnter(page);
  expect(await latexEditorLine.isVisible()).not.toBeTruthy();
  expect(await latexElement.locator(".katex").innerHTML()).toBe(innerHTML);
});

test("add inline latex using markdown shortcut", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  // toggle by space or enter
  await type(page, "aa$$bb$$ cc$$dd$$\n");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa",
    },
    {
      insert: " ",
      attributes: {
        latex: "bb",
      },
    },
    {
      insert: "cc",
    },
    {
      insert: " ",
      attributes: {
        latex: "dd",
      },
    },
  ]);

  await pressArrowUp(page);
  await pressArrowRight(page, 3);
  await pressBackspace(page);
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aacc",
    },
    {
      insert: " ",
      attributes: {
        latex: "dd",
      },
    },
  ]);
});

test("undo-redo when add inline latex using markdown shortcut", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "aa$$bb$$ ");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa",
    },
    {
      insert: " ",
      attributes: {
        latex: "bb",
      },
    },
  ]);
  await assertRichTextInlineRange(page, 0, 3, 0);

  await undoByKeyboard(page);
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa$$bb$$ ",
    },
  ]);
  await assertRichTextInlineRange(page, 0, 9, 0);

  await redoByKeyboard(page);
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa",
    },
    {
      insert: " ",
      attributes: {
        latex: "bb",
      },
    },
  ]);
  await assertRichTextInlineRange(page, 0, 3, 0);
});

test("auto focus after add inline latex using markdown shortcut", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "aa$$ bbb\ncc");
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa",
    },
    {
      insert: " ",
      attributes: {
        latex: "bbb",
      },
    },
    {
      insert: "cc",
    },
  ]);

  await undoByKeyboard(page);
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa",
    },
    {
      insert: " ",
      attributes: {
        latex: "bbb",
      },
    },
  ]);
  await redoByKeyboard(page);
  await assertRichTextInlineDeltas(page, [
    {
      insert: "aa",
    },
    {
      insert: " ",
      attributes: {
        latex: "bbb",
      },
    },
    {
      insert: "cc",
    },
  ]);
});
