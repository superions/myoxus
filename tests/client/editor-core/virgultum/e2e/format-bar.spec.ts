import { expect } from "@playwright/test";
import type { DeltaInsert } from "@virgultum/store";

import {
  activeEmbed,
  captureHistory,
  dragBetweenIndices,
  enterPlaygroundRoom,
  expectConsoleMessage,
  focusRichText,
  focusRichTextEnd,
  focusTitle,
  getBoundingBox,
  getClipboardText,
  getEditorHostLocator,
  getTextOperationSnapshot,
  getSelectionRect,
  initEmptyParagraphState,
  initImageState,
  initThreeParagraphs,
  pasteByKeyboard,
  pressArrowDown,
  pressArrowLeft,
  pressArrowUp,
  pressEnter,
  pressEscape,
  pressTab,
  scrollToBottom,
  scrollToTop,
  selectAllBlocksByKeyboard,
  setInlineRangeInInlineEditor,
  switchReadonly,
  switchToPage,
  type,
  undoByKeyboard,
  updateBlockType,
  waitNextFrame,
  withPressKey,
} from "./utils/actions/index.js";
import {
  assertBlockChildrenFlavours,
  assertBlockChildrenIds,
  assertLocatorVisible,
  assertRichImage,
  assertRichTextInlineDeltas,
  assertRichTextInlineRange,
  assertRichTexts,
} from "./utils/asserts.js";
import { test } from "./utils/playwright.js";
import { getFormatBar } from "./utils/query.js";

test("should format quick bar show when select text", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await dragBetweenIndices(page, [0, 0], [2, 3]);
  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();

  const box = await formatBar.boundingBox();
  if (!box) {
    throw new Error("formatBar doesn't exist");
  }
  const rect = await getSelectionRect(page);
  expect(box.x).toBeLessThan(rect.right);
  expect(box.x + box.width).toBeGreaterThan(rect.left);
  expect(box.y + box.height).toBeLessThanOrEqual(rect.top);

  // Click the edge of the format quick bar
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  // Even not any button is clicked, the format quick bar should't be hidden
  await expect(formatBar).toBeVisible();

  await focusRichText(page);
  await expect(formatBar).not.toBeVisible();
});

test("should format quick bar show when clicking drag handle", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  const locator = page.locator("myoxus-paragraph").first();
  await locator.hover();
  const dragHandle = page.locator(".myoxus-drag-handle-grabber");
  const dragHandleRect = await dragHandle.boundingBox();
  if (!dragHandleRect) {
    throw new Error("dragHandleRect is not found");
  }
  await dragHandle.click();

  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();
});

test("should format quick bar show when select text by keyboard", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello world");
  await withPressKey(page, "Shift", async () => {
    let i = 10;
    while (i--) {
      await page.keyboard.press("ArrowLeft");
      await waitNextFrame(page);
    }
  });

  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();

  const formatBarBox = await formatBar.boundingBox();
  if (!formatBarBox) {
    throw new Error("formatBar doesn't exist");
  }
  let selectionRect = await getSelectionRect(page);
  expect(formatBarBox.x).toBeLessThan(selectionRect.right);
  expect(formatBarBox.x + formatBarBox.width).toBeGreaterThan(
    selectionRect.left,
  );
  expect(formatBarBox.y + formatBarBox.height).toBeLessThanOrEqual(
    selectionRect.top,
  );

  await page.keyboard.press("ArrowLeft");
  await expect(formatBar).not.toBeVisible();

  await withPressKey(page, "Shift", async () => {
    let i = 10;
    while (i--) {
      await page.keyboard.press("ArrowRight");
      await waitNextFrame(page);
    }
  });

  await expect(formatBar).toBeVisible();

  const rightBox = await formatBar.boundingBox();
  if (!rightBox) {
    throw new Error("formatBar doesn't exist");
  }
  // Preserve selection anchoring without freezing historical font/toolbar sizes.
  selectionRect = await getSelectionRect(page);
  expect(rightBox.x).toBeLessThan(selectionRect.right);
  expect(rightBox.x + rightBox.width).toBeGreaterThan(selectionRect.left);
  expect(rightBox.y + rightBox.height).toBeLessThanOrEqual(selectionRect.top);
});

test("should format quick bar can only display one at a time", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await dragBetweenIndices(page, [0, 3], [0, 0]);
  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();

  await dragBetweenIndices(page, [2, 0], [2, 3]);
  await expect(formatBar).toHaveCount(1);
});

test("should format quick bar hide when type text", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await dragBetweenIndices(page, [0, 0], [2, 3]);
  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();
  await type(page, "1");
  await expect(formatBar).not.toBeVisible();
});

test("should format quick bar be able to format text", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  // drag only the `456` paragraph
  await dragBetweenIndices(page, [1, 0], [1, 3]);

  const { boldBtn, italicBtn, underlineBtn, strikeBtn, codeBtn } =
    getFormatBar(page);

  await expect(boldBtn).toHaveAttribute("aria-pressed", "false");
  await expect(italicBtn).not.toHaveAttribute("active", "");
  await expect(underlineBtn).not.toHaveAttribute("active", "");
  await expect(strikeBtn).not.toHaveAttribute("active", "");
  await expect(codeBtn).not.toHaveAttribute("active", "");

  await boldBtn.click();
  await italicBtn.click();
  await underlineBtn.click();
  await strikeBtn.click();
  await codeBtn.click();

  // The button should be active after click
  await expect(boldBtn).toHaveAttribute("active", "");
  await expect(italicBtn).toHaveAttribute("active", "");
  await expect(underlineBtn).toHaveAttribute("active", "");
  await expect(strikeBtn).toHaveAttribute("active", "");
  await expect(codeBtn).toHaveAttribute("active", "");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await boldBtn.click();
  await underlineBtn.click();
  await codeBtn.click();

  await waitNextFrame(page);

  // The bold button should be inactive after click again
  await expect(boldBtn).not.toHaveAttribute("active", "");
  await expect(italicBtn).toHaveAttribute("active", "");
  await expect(underlineBtn).not.toHaveAttribute("active", "");
  await expect(strikeBtn).toHaveAttribute("active", "");
  await expect(codeBtn).not.toHaveAttribute("active", "");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );
});

test("should render the chosen text marker color on a word fragment", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "Myoxus text marker works");

  // Select only the `text` word inside the paragraph.
  await dragBetweenIndices(page, [0, 7], [0, 11]);

  const { highlight } = getFormatBar(page);
  await highlight.highlightBtn.click();
  await highlight.chooseRedBackground();

  await assertRichTextInlineDeltas(page, [
    { insert: "Myoxus " },
    {
      insert: "text",
      attributes: {
        background: "var(--myoxus-text-highlight-red)",
      },
    },
    { insert: " marker works" },
  ]);

  const renderedMarker = await page
    .locator("myoxus-paragraph")
    .first()
    .evaluate((paragraph) => {
      const element = Array.from(paragraph.querySelectorAll("v-element")).find(
        (candidate) => candidate.textContent === "text",
      );
      const wrapper =
        element?.querySelector<HTMLElement>("myoxus-text > span") ?? null;
      if (!wrapper) throw new Error("Text marker wrapper was not rendered");

      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--myoxus-text-highlight-red)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();

      return {
        computed: getComputedStyle(wrapper).backgroundColor,
        expected,
        inline: wrapper.style.backgroundColor,
      };
    });
  expect(renderedMarker.inline).toBe("var(--myoxus-text-highlight-red)");
  expect(renderedMarker.expected).not.toBe("");
  expect(renderedMarker.computed).toBe(renderedMarker.expected);
});

test("should preserve and render a semantic label tone in a table cell", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "/table");
  await pressEnter(page);
  await waitNextFrame(page);

  const cell = page.locator("myoxus-table-cell").first();
  await cell.click();
  await cell.click();
  await page.keyboard.type("Status");
  await cell.locator("v-line").click({ clickCount: 3 });

  const { formatBar } = getFormatBar(page);
  const labelToneButton = formatBar.locator(
    'editor-icon-button[aria-label^="Label tone:"]',
  );
  await expect(labelToneButton).toBeVisible();
  await labelToneButton.click();
  await page.getByTestId("label-tone-positive").click();

  await assertRichTextInlineDeltas(page, [
    { insert: "Status", attributes: { labelTone: "positive" } },
  ]);
  const renderedLabel = await cell
    .locator("myoxus-text > span")
    .evaluate((element) => ({
      background: element.style.backgroundColor,
      color: element.style.color,
      typography: element.style.fontSize,
    }));
  expect(renderedLabel).toEqual({
    background: "var(--myoxus-sem-status-success-paper)",
    color: "var(--myoxus-sem-status-success-deep)",
    typography: "var(--myoxus-typography-label-compact-size)",
  });

  await cell.locator("v-line").click({ clickCount: 3 });
  await expect(labelToneButton).toHaveAttribute(
    "aria-label",
    "Label tone: Positive",
  );
  await labelToneButton.click();
  await page.getByTestId("label-tone-clear").click();
  await assertRichTextInlineDeltas(page, [{ insert: "Status" }]);
});

test("should format quick bar be able to format text when select multiple line", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await dragBetweenIndices(page, [0, 0], [2, 3]);

  const { boldBtn } = getFormatBar(page);
  await expect(boldBtn).not.toHaveAttribute("active", "");
  await boldBtn.click();

  // The bold button should be active after click
  await expect(boldBtn).toHaveAttribute("active", "");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await boldBtn.click();
  await expect(boldBtn).not.toHaveAttribute("active", "");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );
});

test("should format quick bar be able to link text", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  // drag only the `456` paragraph
  await dragBetweenIndices(page, [1, 0], [1, 3]);

  const { linkBtn } = getFormatBar(page);
  await expect(linkBtn).not.toHaveAttribute("active", "");
  await linkBtn.click();

  const linkPopoverInput = page.locator(".myoxus-link-popover-input");
  await expect(linkPopoverInput).toBeVisible();

  const url = "https://www.example.com";

  await type(page, url);
  await pressEnter(page);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  const linkLocator = page.locator("myoxus-link a");
  await expect(linkLocator).toHaveAttribute("href", url);

  await focusRichTextEnd(page);

  await dragBetweenIndices(page, [1, 3], [1, 0]);

  // The link button should be active after click
  await expect(linkBtn).toHaveAttribute("active", "");
  await linkBtn.click();
  await waitNextFrame(page);
  await expect(linkBtn).not.toHaveAttribute("active", "");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );
});

test("should format quick bar be able to change to heading paragraph type", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  // drag only the `456` paragraph
  await dragBetweenIndices(page, [0, 0], [0, 3]);

  const { openParagraphMenu, textBtn, h1Btn, bulletedBtn } = getFormatBar(page);

  await openParagraphMenu();
  await h1Btn.click();

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await openParagraphMenu();
  await bulletedBtn.click();

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_bulleted.json`,
  );

  await openParagraphMenu();
  await textBtn.click();

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );
  await page.waitForTimeout(10);
  // The paragraph button should prevent selection after click
  await assertRichTextInlineRange(page, 0, 0, 3);
});

test("should format quick bar not show at readonly mode", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await switchReadonly(page);

  await dragBetweenIndices(page, [0, 0], [2, 3]);
  const { formatBar } = getFormatBar(page);
  await expect(formatBar).not.toBeVisible();

  const editorHost = getEditorHostLocator(page);
  const richText = editorHost.locator("rich-text").nth(0);
  await richText.dblclick({
    position: { x: 10, y: 10 },
  });
  await expect(formatBar).not.toBeVisible();
});

test("should format bar follow scroll", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  for (let i = 0; i < 30; i++) {
    await pressEnter(page);
  }

  await scrollToTop(page);

  await dragBetweenIndices(page, [0, 0], [2, 3]);
  const { formatBar, boldBtn } = getFormatBar(page);
  await assertLocatorVisible(page, formatBar);

  await scrollToBottom(page);

  await assertLocatorVisible(page, formatBar, false);

  // should format bar follow scroll after click bold button
  await scrollToTop(page);
  await assertLocatorVisible(page, formatBar);
  await boldBtn.click();
  await scrollToBottom(page);
  await assertLocatorVisible(page, formatBar, false);

  // should format bar follow scroll after transform text type
  await scrollToTop(page);
  await assertLocatorVisible(page, formatBar);
  await updateBlockType(page, "myoxus:list", "bulleted");
  await scrollToBottom(page);
  await assertLocatorVisible(page, formatBar, false);
});

test("should format quick bar action status updated while undo", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "helloworld");
  await captureHistory(page);
  await dragBetweenIndices(page, [0, 1], [0, 6]);

  const { formatBar, boldBtn } = getFormatBar(page);
  await expect(formatBar).toBeVisible();
  await expect(boldBtn).toBeVisible();

  await expect(boldBtn).not.toHaveAttribute("active", "");
  await boldBtn.click();
  await expect(boldBtn).toHaveAttribute("active", "");

  await undoByKeyboard(page);
  await expect(formatBar).toBeVisible();
  await expect(boldBtn).not.toHaveAttribute("active", "");
});

test("should format quick bar work in single block selection", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  await dragBetweenIndices(
    page,
    [1, 0],
    [1, 3],
    { x: -26 - 24, y: -10 },
    { x: 0, y: 0 },
  );
  const blockSelections = page
    .locator("myoxus-block-selection")
    .locator("visible=true");
  await expect(blockSelections).toHaveCount(1);

  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();

  const boldBtn = formatBar.getByTestId("bold");
  await boldBtn.click();
  const italicBtn = formatBar.getByTestId("italic");
  await italicBtn.click();
  const underlineBtn = formatBar.getByTestId("underline");
  await underlineBtn.click();
  //FIXME: trt to cancel italic
  // Cancel italic
  // await italicBtn.click();

  await expect(blockSelections).toHaveCount(1);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );

  const noteEl = page.locator("myoxus-note");
  const { x, y, width, height } = await getBoundingBox(noteEl);
  await page.mouse.click(x + width / 2, y + height / 2);
  await expect(formatBar).not.toBeVisible();
});

test("should format quick bar work in multiple block selection", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  await dragBetweenIndices(
    page,
    [2, 3],
    [0, 0],
    { x: 20, y: 20 },
    { x: 0, y: 0 },
  );
  const blockSelections = page
    .locator("myoxus-block-selection")
    .locator("visible=true");
  await expect(blockSelections).toHaveCount(3);

  const formatBarController = getFormatBar(page);
  await expect(formatBarController.formatBar).toBeVisible();

  await formatBarController.boldBtn.click();
  await formatBarController.italicBtn.click();
  await formatBarController.underlineBtn.click();
  // Cancel italic
  await formatBarController.italicBtn.click();

  await expect(blockSelections).toHaveCount(3);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );

  const noteEl = page.locator("myoxus-note");
  const { x, y, width, height } = await getBoundingBox(noteEl);
  await page.mouse.click(x + width / 2, y + height / 2);
  await expect(formatBarController.formatBar).not.toBeVisible();
});

test("should format quick bar with block selection works when update block type", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  await dragBetweenIndices(
    page,
    [2, 3],
    [0, 0],
    { x: 20, y: 20 },
    { x: 0, y: 0 },
  );
  const blockSelections = page
    .locator("myoxus-block-selection")
    .locator("visible=true");
  await expect(blockSelections).toHaveCount(3);

  const formatBarController = getFormatBar(page);
  await expect(formatBarController.formatBar).toBeVisible();

  await formatBarController.openParagraphMenu();
  await formatBarController.bulletedBtn.click();
  await expect(blockSelections).toHaveCount(3);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await formatBarController.openParagraphMenu();
  await formatBarController.h1Btn.click();
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_final.json`,
  );
  await expect(formatBarController.formatBar).toBeVisible();
  await expect(blockSelections).toHaveCount(3);

  const noteEl = page.locator("myoxus-note");
  const { x, y, width, height } = await getBoundingBox(noteEl);
  await page.mouse.click(x + width / 2, y + height / 2);
  await expect(formatBarController.formatBar).not.toBeVisible();
});

test("should format quick bar show after convert to code block", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  const formatBarController = getFormatBar(page);
  await dragBetweenIndices(
    page,
    [2, 3],
    [0, 0],
    { x: 20, y: 20 },
    { x: 0, y: 0 },
  );
  await expect(formatBarController.formatBar).toBeVisible();
  await expect(formatBarController.formatBar).toBeInViewport();

  await formatBarController.openParagraphMenu();
  await formatBarController.codeBlockBtn.click();
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
});

test("buttons in format quick bar should have correct active styles", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  // `45`
  await setInlineRangeInInlineEditor(
    page,
    {
      index: 0,
      length: 2,
    },
    2,
  );
  const { codeBtn } = getFormatBar(page);
  await codeBtn.click();
  await expect(codeBtn).toHaveAttribute("active", "");

  // `456`
  await setInlineRangeInInlineEditor(
    page,
    {
      index: 0,
      length: 3,
    },
    2,
  );
  await expect(codeBtn).not.toHaveAttribute("active", "");
});

test("should format bar style active correctly", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await page.evaluate(() => {
    const { doc } = window;
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    const note = doc.addBlock("myoxus:note", {}, rootId);
    const delta = [
      { insert: "1", attributes: { bold: true, italic: true } },
      { insert: "2", attributes: { bold: true, underline: true } },
      { insert: "3", attributes: { bold: true, code: true } },
    ];
    const text = new window.$virgultum.store.Text(delta as DeltaInsert[]);
    doc.addBlock("myoxus:paragraph", { text }, note);
  });

  const { boldBtn, codeBtn, underlineBtn } = getFormatBar(page);
  await dragBetweenIndices(page, [0, 0], [0, 3]);
  await expect(boldBtn).toHaveAttribute("active", "");
  await expect(underlineBtn).not.toHaveAttribute("active", "");
  await expect(codeBtn).not.toHaveAttribute("active", "");

  await underlineBtn.click();
  await expect(underlineBtn).toHaveAttribute("active", "");
  await expect(boldBtn).toHaveAttribute("active", "");
  await expect(codeBtn).not.toHaveAttribute("active", "");
});

test("should show format-quick-bar and select all text of the block when triple clicking on text", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello world");

  const editorHost = getEditorHostLocator(page);
  const locator = editorHost.locator(".inline-editor").nth(0);
  const textBox = await locator.boundingBox();
  if (!textBox) {
    throw new Error("Can't get bounding box");
  }

  await page.mouse.dblclick(textBox.x + 10, textBox.y + textBox.height / 2);

  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();

  await assertRichTextInlineRange(page, 0, 0, 5);

  const noteEl = page.locator("myoxus-note");
  const { x, y, width, height } = await getBoundingBox(noteEl);
  await page.mouse.click(x + width / 2, y + height / 2);

  await expect(formatBar).toBeHidden();

  await page.mouse.move(textBox.x + 10, textBox.y + textBox.height / 2);

  const options = {
    clickCount: 1,
  };
  await page.mouse.down(options);
  await page.mouse.up(options);

  options.clickCount++;
  await page.mouse.down(options);
  await page.mouse.up(options);

  options.clickCount++;
  await page.mouse.down(options);
  await page.mouse.up(options);

  await assertRichTextInlineRange(page, 0, 0, "hello world".length);
});

test("should update the format quick bar state when there is a change in keyboard selection", async ({
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
    const delta = [
      { insert: "1", attributes: { bold: true } },
      { insert: "2", attributes: { bold: true } },
      { insert: "3", attributes: { bold: false } },
    ];
    const text = new window.$virgultum.store.Text(delta as DeltaInsert[]);
    doc.addBlock("myoxus:paragraph", { text }, note);
  });
  await focusTitle(page);
  await pressArrowDown(page);

  const formatBar = getFormatBar(page);
  await withPressKey(page, "Shift", async () => {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(formatBar.boldBtn).toHaveAttribute("active", "");
    await page.keyboard.press("ArrowRight");
    await expect(formatBar.boldBtn).not.toHaveAttribute("active", "");
  });
});

test("format quick bar should not break cursor jumping", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);
  await dragBetweenIndices(page, [1, 3], [1, 2]);

  const { formatBar } = getFormatBar(page);
  await expect(formatBar).toBeVisible();

  await pressArrowUp(page);
  await type(page, "0");
  await assertRichTexts(page, ["1203", "456", "789"]);

  await dragBetweenIndices(page, [1, 3], [1, 2]);
  await pressArrowDown(page);
  await type(page, "0");
  await assertRichTexts(page, ["1203", "456", "7809"]);
});

test("selecting image should not show format bar", async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/4535",
  });
  await enterPlaygroundRoom(page);
  await initImageState(page);
  await assertRichImage(page, 1);
  await activeEmbed(page);
  await waitNextFrame(page);
  const { formatBar } = getFormatBar(page);
  await expect(formatBar).not.toBeVisible();
});

test("create linked doc from block selection with format bar", async ({
  page,
}) => {
  expectConsoleMessage(page, /Failed to copy a block into the linked document/);
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await initThreeParagraphs(page);

  await focusRichText(page, 1);
  await pressTab(page);
  await assertRichTexts(page, ["123", "456", "789"]);
  await assertBlockChildrenIds(page, "1", ["2", "4"]);
  await assertBlockChildrenIds(page, "2", ["3"]);

  await selectAllBlocksByKeyboard(page);
  await waitNextFrame(page, 200);

  const blockSelections = page
    .locator("myoxus-block-selection")
    .locator("visible=true");
  await expect(blockSelections).toHaveCount(2);

  const { createLinkedDocBtn } = getFormatBar(page);
  expect(await createLinkedDocBtn.isVisible()).toBe(true);
  const sourceBefore = await getTextOperationSnapshot(page);
  const docIdsBefore = await page.evaluate(() =>
    window.collection.meta.docMetas.map((meta) => meta.id),
  );
  // The transformer signals a failed import with undefined. Exercise that
  // boundary once, then restore it before the same real conversion journey.
  await page.evaluate(() => {
    const clipboard = window.editor.std.clipboard;
    const original = clipboard.pasteBlockSnapshot;
    clipboard.pasteBlockSnapshot = async () => {
      clipboard.pasteBlockSnapshot = original;
      return undefined;
    };
  });
  const failedCopy = page.waitForEvent("console", {
    predicate: (message) =>
      message.type() === "error" &&
      message
        .text()
        .includes("Failed to copy a block into the linked document"),
  });
  await createLinkedDocBtn.click();
  await failedCopy;
  expect(await getTextOperationSnapshot(page)).toBe(sourceBefore);
  expect(
    await page.evaluate(() =>
      window.collection.meta.docMetas.map((meta) => meta.id),
    ),
  ).toEqual(docIdsBefore);
  await focusRichText(page, 2);
  await selectAllBlocksByKeyboard(page);
  await expect(blockSelections).toHaveCount(2);
  await createLinkedDocBtn.click();

  const linkedDocBlock = page.locator("myoxus-embed-linked-doc-block");
  await expect(linkedDocBlock).toHaveCount(1);

  // App navigation is a host stub here; open the actual conversion result with
  // the existing fixture switch instead of claiming a no-op double-click did it.
  const targetDocId = await page.evaluate(
    () =>
      document.querySelector("myoxus-embed-linked-doc-block")!.model.props
        .pageId,
  );
  await assertBlockChildrenFlavours(page, "1", ["myoxus:embed-linked-doc"]);
  expect(docIdsBefore).not.toContain(targetDocId);
  await switchToPage(page, targetDocId);
  await assertRichTexts(page, ["123", "456", "789"]);
});

test.describe("more menu button", () => {
  test("should be able to perform the copy action", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await initThreeParagraphs(page);
    // drag only the `456` paragraph
    await dragBetweenIndices(page, [1, 0], [1, 3]);

    const { openMoreMenu, moreBtn, copyBtn } = getFormatBar(page);
    await openMoreMenu();
    await expect(copyBtn).toBeVisible();
    await assertRichTextInlineRange(page, 1, 0, 3);
    await copyBtn.click();
    await assertRichTextInlineRange(page, 1, 0, 3);
    await expect.poll(() => getClipboardText(page)).toBe("456");
    await moreBtn.click();
    await expect(copyBtn).toBeHidden();

    await focusRichText(page, 1);
    await pasteByKeyboard(page, false);
    await waitNextFrame(page);

    await assertRichTexts(page, ["123", "456456", "789"]);
  });

  test("should be able to perform the duplicate action", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await initThreeParagraphs(page);

    await focusRichText(page, 1);
    await pressEscape(page);

    const { openMoreMenu, duplicateBtn } = getFormatBar(page);
    await openMoreMenu();
    await expect(duplicateBtn).toBeVisible();
    await duplicateBtn.click();

    await waitNextFrame(page);

    await assertRichTexts(page, ["123", "456", "456", "789"]);
  });

  test("should be able to perform the delete action", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await initThreeParagraphs(page);

    await focusRichText(page, 1);
    await pressEscape(page);

    const { openMoreMenu, deleteBtn } = getFormatBar(page);
    await openMoreMenu();
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    await waitNextFrame(page);

    await assertRichTexts(page, ["123", "789"]);
  });
});

test("should not display format bar when just select embed node", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page, 0);
  await type(page, "@\n");
  await assertRichTextInlineRange(page, 0, 1, 0);
  await pressArrowLeft(page);
  await assertRichTextInlineRange(page, 0, 0, 1);

  const { boldBtn } = getFormatBar(page);
  await expect(boldBtn).toBeHidden();
});
