import { readFileSync } from "node:fs";

import { expect, type Page } from "@playwright/test";

import {
  addNewPage,
  switchReadonly,
  switchToPage,
} from "./utils/actions/click.js";
import { dragBetweenIndices, dragBlockToPoint } from "./utils/actions/drag.js";
import {
  activeNoteInEdgeless,
  switchEditorMode,
} from "./utils/actions/edgeless.js";
import {
  copyByKeyboard,
  cutByKeyboard,
  pasteByKeyboard,
  pressArrowLeft,
  pressBackspace,
  pressEnter,
  pressEscape,
  redoByKeyboard,
  selectAllByKeyboard,
  SHORT_KEY,
  type,
  undoByKeyboard,
} from "./utils/actions/keyboard.js";
import { getLinkedDocPopover } from "./utils/actions/linked-doc.js";
import {
  captureHistory,
  enterPlaygroundRoom,
  focusRichText,
  focusTitle,
  getPageSnapshot,
  getTextOperationSnapshot,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  setInlineRangeInSelectedRichText,
  waitNextFrame,
} from "./utils/actions/misc.js";
import {
  assertParentBlockFlavour,
  assertRichTexts,
  assertTitle,
} from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

async function createAndConvertToEmbedLinkedDoc(page: Page) {
  const { createLinkedDoc } = getLinkedDocPopover(page);
  const linkedDoc = await createLinkedDoc("page1");
  const lickedDocBox = await linkedDoc.boundingBox();
  if (!lickedDocBox) {
    throw new Error("lickedDocBox is not found");
  }
  await page.mouse.move(
    lickedDocBox.x + lickedDocBox.width / 2,
    lickedDocBox.y + lickedDocBox.height / 2,
  );

  await waitNextFrame(page, 200);
  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toBeVisible();

  const switchButton = toolbar.getByRole("combobox", { name: "Switch view" });
  await switchButton.click();

  const embedLinkedDocBtn = toolbar.getByRole("option", { name: "Card view" });
  await expect(embedLinkedDocBtn).toBeVisible();
  await embedLinkedDocBtn.click();
  await waitNextFrame(page, 200);
}

test.describe("reference node", () => {
  test("linked doc popover can show and hide correctly", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "[[");

    // `[[` should be converted to `@`
    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
    const { linkedDocPopover } = getLinkedDocPopover(page);
    await expect(linkedDocPopover).toBeVisible();
    await pressEscape(page);
    await expect(linkedDocPopover).toBeHidden();
    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await assertRichTexts(page, ["@@"]);
    await pressBackspace(page);
    await expect(linkedDocPopover).toBeHidden();
  });

  test("linked doc popover should not show when the current content is @xx and pressing backspace", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "@");
    await page.keyboard.press("Escape");
    await type(page, "a");

    const { linkedDocPopover } = getLinkedDocPopover(page);
    await expect(linkedDocPopover).toBeHidden();

    await pressBackspace(page);
    await expect(linkedDocPopover).toBeHidden();
  });

  test("close doc popover when start with space", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "@d");
    const { linkedDocPopover } = getLinkedDocPopover(page);
    await expect(linkedDocPopover).toBeVisible();
    await pressBackspace(page);
    await expect(linkedDocPopover).toBeVisible();
    await type(page, " ");
    await expect(linkedDocPopover).toBeHidden();
    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await type(page, " ");
    await expect(linkedDocPopover).toBeHidden();
  });

  test("should reference node attributes correctly", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await addNewPage(page);
    await focusRichText(page);
    await type(page, "[[");
    await pressEnter(page);

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}_1.json`,
    );

    await pressBackspace(page);
    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}_2.json`,
    );
  });

  test("reference identity survives undo, document switches, and readonly mode", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    const sourceId = await page.evaluate(() => window.editor.doc.id);
    const target = await addNewPage(page, "Persistent target");
    await focusRichText(page);
    await type(page, "[[");
    await pressEnter(page);

    const referenceSnapshot = await getPageSnapshot(page, true);
    const referenceIdentity = `"pageId": "${target.id}"`;
    expect(referenceSnapshot).toContain(referenceIdentity);
    expect(referenceSnapshot).not.toContain('"title": "Persistent target"');

    await undoByKeyboard(page);
    await expect
      .poll(() => getPageSnapshot(page, true))
      .not.toContain(referenceIdentity);
    await redoByKeyboard(page);
    await expect
      .poll(() => getPageSnapshot(page, true))
      .toContain(referenceIdentity);

    await switchToPage(page, target.id);
    await switchToPage(page, sourceId);
    await expect
      .poll(() => getPageSnapshot(page, true))
      .toContain(referenceIdentity);

    await switchReadonly(page);
    const readonlySnapshot = await getPageSnapshot(page, true);
    await focusRichText(page);
    await type(page, "must not persist");
    expect(await getPageSnapshot(page, true)).toBe(readonlySnapshot);
  });

  test("should reference node can be selected", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await addNewPage(page);
    await focusRichText(page);

    await type(page, "1");
    await type(page, "[[");
    await pressEnter(page);

    await assertRichTexts(page, ["1 "]);
    await type(page, "2");
    await assertRichTexts(page, ["1 2"]);
    await page.keyboard.press("ArrowLeft");
    await type(page, "3");
    await assertRichTexts(page, ["1 32"]);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    // select the reference node
    await page.keyboard.press("ArrowLeft");

    // delete the reference node and insert text
    await type(page, "4");
    await assertRichTexts(page, ["1432"]);
  });

  test("text inserted in the between of reference nodes should not be extend attributes", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await addNewPage(page);
    await focusRichText(page);

    await type(page, "1");
    await type(page, "@");
    await pressEnter(page);
    await type(page, "@");
    await pressEnter(page);

    await assertRichTexts(page, ["1  "]);
    await type(page, "2");
    await assertRichTexts(page, ["1  2"]);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await type(page, "3");
    await assertRichTexts(page, ["1 3 2"]);

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
  });

  test("text can be inserted as expected when reference node is in the start or end of line", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await addNewPage(page);
    await focusRichText(page);

    await type(page, "@");
    await pressEnter(page);
    await type(page, "@");
    await pressEnter(page);

    await assertRichTexts(page, ["  "]);
    await type(page, "2");
    await assertRichTexts(page, ["  2"]);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await type(page, "3");
    await assertRichTexts(page, [" 3 2"]);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await type(page, "1");
    await assertRichTexts(page, ["1 3 2"]);

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
  });

  test("should the cursor move correctly around reference node", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await addNewPage(page);
    await focusRichText(page);

    await type(page, "1");
    await type(page, "[[");
    await pressEnter(page);

    await assertRichTexts(page, ["1 "]);
    await type(page, "2");
    await assertRichTexts(page, ["1 2"]);
    await page.keyboard.press("ArrowLeft");
    await type(page, "3");
    await assertRichTexts(page, ["1 32"]);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");
    await waitNextFrame(page);
    await page.keyboard.press("ArrowLeft");

    await type(page, "4");
    await assertRichTexts(page, ["14 32"]);

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}_1.json`,
    );

    await page.keyboard.press("ArrowRight");
    await captureHistory(page);
    await pressBackspace(page);

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}_2.json`,
    );
  });

  test("should create reference node works", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    const { id: newId } = await addNewPage(page, "title");

    await focusRichText(page);
    await type(page, "@");
    const {
      linkedDocPopover,
      refNode,
      assertExistRefText: assertReferenceText,
    } = getLinkedDocPopover(page);
    await expect(linkedDocPopover).toBeVisible();
    await pressEnter(page);
    await expect(linkedDocPopover).toBeHidden();
    await assertRichTexts(page, [" "]);
    await expect(refNode).toBeVisible();
    await expect(refNode).toHaveCount(1);
    await assertReferenceText("title");

    // Reference invalidation consumes workspace metadata, not a Core title UI.
    await page.evaluate((id) => {
      window.collection.meta.setDocMeta(id, { title: "titl1" });
    }, newId);
    await assertReferenceText("titl1");
  });

  test("should not merge consecutive identical reference nodes for rendering", async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "issue",
      description: "https://github.com/example/virgultum/issues/2136",
    });
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "[[");
    await pressEnter(page);
    await type(page, "[[");
    await pressEnter(page);

    const { refNode } = getLinkedDocPopover(page);
    await assertRichTexts(page, ["  "]);
    await expect(refNode).toHaveCount(2);
  });
});

test.describe("linked page popover", () => {
  test("should show linked page popover show and hide", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    const { linkedDocPopover } = getLinkedDocPopover(page);

    await type(page, "[[");
    await expect(linkedDocPopover).toBeVisible();
    await pressBackspace(page);
    await expect(linkedDocPopover).toBeHidden();

    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(linkedDocPopover).toBeHidden();

    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await copyByKeyboard(page);
    await expect(linkedDocPopover).toBeHidden();
  });

  test("should fuzzy search works", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    const {
      linkedDocPopover,
      pageBtn,
      assertExistRefText,
      assertActivePageIdx,
    } = getLinkedDocPopover(page);

    await focusTitle(page);
    await type(page, "page0");

    await addNewPage(page, "page1");
    await addNewPage(page, "page2");
    await focusRichText(page);
    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await expect(pageBtn).toHaveCount(4);

    await assertActivePageIdx(0);
    await page.keyboard.press("ArrowDown");
    await assertActivePageIdx(1);

    await page.keyboard.press("ArrowUp");
    await assertActivePageIdx(0);
    await page.keyboard.press("Tab");
    await assertActivePageIdx(1);
    await page.keyboard.press("Shift+Tab");
    await assertActivePageIdx(0);

    await expect(pageBtn).toHaveText([
      "page1",
      "page2",
      'Create "Untitled" doc',
      "Import",
    ]);
    // page2
    //  ^  ^
    await type(page, "a2");
    await expect(pageBtn).toHaveCount(3);
    await expect(pageBtn).toHaveText(["page2", 'Create "a2" doc', "Import"]);
    await pressEnter(page);
    await expect(linkedDocPopover).toBeHidden();
    await assertExistRefText("page2");
  });

  test("should paste query works", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);

    await (async () => {
      for (let index = 0; index < 3; index++) {
        await addNewPage(page, "page" + index);
      }
    })();

    await switchToPage(page);
    await focusRichText(page);
    await type(page, "e2");
    await setInlineRangeInSelectedRichText(page, 0, 2);
    await cutByKeyboard(page);

    const { pageBtn, linkedDocPopover } = getLinkedDocPopover(page);
    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await expect(pageBtn).toHaveText([
      "page0",
      "page1",
      "page2",
      'Create "Untitled" doc',
      "Import",
    ]);

    await page.keyboard.press(`${SHORT_KEY}+v`);
    await expect(linkedDocPopover).toBeVisible();
    await expect(pageBtn).toHaveText(["page2", 'Create "e2" doc', "Import"]);
  });

  test("should multiple paste query not works", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);

    await (async () => {
      for (let index = 0; index < 3; index++) {
        await addNewPage(page, "page" + index);
      }
    })();

    await switchToPage(page);
    await focusRichText(page);
    await type(page, "pa");
    await pressEnter(page);
    await type(page, "ge");
    await pressEnter(page);
    await type(page, "2");

    await selectAllByKeyboard(page);
    await waitNextFrame(page, 200);
    await selectAllByKeyboard(page);
    await waitNextFrame(page, 200);
    await selectAllByKeyboard(page);
    await waitNextFrame(page, 200);
    await cutByKeyboard(page);
    const note = page.locator("myoxus-note");
    await note.click({ force: true, position: { x: 100, y: 100 } });
    await waitNextFrame(page, 200);

    const { pageBtn, linkedDocPopover } = getLinkedDocPopover(page);
    await type(page, "@");
    await expect(linkedDocPopover).toBeVisible();
    await expect(pageBtn).toHaveText([
      "page0",
      "page1",
      "page2",
      'Create "Untitled" doc',
      "Import",
    ]);

    await page.keyboard.press(`${SHORT_KEY}+v`);
    await expect(linkedDocPopover).not.toBeVisible();
  });

  test("should more docs works", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);

    await (async () => {
      for (let index = 0; index < 10; index++) {
        await addNewPage(page, "page" + index);
      }
    })();

    await switchToPage(page);
    await focusRichText(page);
    await type(page, "@");

    const { pageBtn, linkedDocPopover } = getLinkedDocPopover(page);
    await expect(linkedDocPopover).toBeVisible();
    await expect(pageBtn).toHaveText([
      ...Array.from({ length: 6 }, (_, index) => `page${index}`),
      "4 more docs",
      'Create "Untitled" doc',
      "Import",
    ]);

    const moreNode = page.locator(`icon-button[data-id="Link to Doc More"]`);
    await moreNode.click();
    await expect(pageBtn).toHaveText([
      ...Array.from({ length: 10 }, (_, index) => `page${index}`),
      'Create "Untitled" doc',
      "Import",
    ]);
  });
});

test.describe("linked page with clipboard", () => {
  test("paste linked page should paste as linked page", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    const { createLinkedDoc } = getLinkedDocPopover(page);

    await createLinkedDoc("page1");

    const before = JSON.parse(await getPageSnapshot(page, true));
    await selectAllByKeyboard(page);
    await copyByKeyboard(page);
    await focusRichText(page);
    await pasteByKeyboard(page);
    const expected = JSON.parse(
      readFileSync(testInfo.snapshotPath(`${testInfo.title}.json`), "utf8"),
    );
    // Copy must preserve every Note property, not yesterday's theme palette.
    expected.children[0].props = before.children[0].props;
    await expect
      .poll(async () => JSON.parse(await getPageSnapshot(page, true)))
      .toEqual(expected);
  });

  test("duplicated linked page should paste as linked page", async ({
    page,
  }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    const { createLinkedDoc } = getLinkedDocPopover(page);

    await createLinkedDoc("page0");

    const before = JSON.parse(await getPageSnapshot(page, true));
    await type(page, "/duplicate");
    await pressEnter(page);
    const expected = JSON.parse(
      readFileSync(testInfo.snapshotPath(`${testInfo.title}.json`), "utf8"),
    );
    expected.children[0].props = before.children[0].props;
    await expect
      .poll(async () => JSON.parse(await getPageSnapshot(page, true)))
      .toEqual(expected);
  });
});

test("should [[Selected text]] converted to linked page", async ({
  page,
}, testInfo) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/2730",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "1234");

  await dragBetweenIndices(page, [0, 1], [0, 2]);
  await type(page, "[");
  await assertRichTexts(page, ["1[2]34"]);
  await type(page, "[");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
  await switchToPage(page, "3");
  await assertTitle(page, "2");
});

test("add reference node before the other reference node", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaa");

  const firstRefNode = page.locator("myoxus-reference").nth(0);

  await type(page, "@bbb");
  await pressEnter(page);

  expect(await firstRefNode.textContent()).toEqual(
    expect.stringContaining("bbb"),
  );
  expect(await firstRefNode.textContent()).not.toEqual(
    expect.stringContaining("ccc"),
  );

  await pressArrowLeft(page, 3);
  await type(page, "@ccc");
  await pressEnter(page);

  expect(await firstRefNode.textContent()).not.toEqual(
    expect.stringContaining("bbb"),
  );
  expect(await firstRefNode.textContent()).toEqual(
    expect.stringContaining("ccc"),
  );
});

test("linked doc can be dragged from note to surface top level block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await focusTitle(page);
  await type(page, "title0");
  await focusRichText(page);
  await createAndConvertToEmbedLinkedDoc(page);
  const linkedDocId = await page
    .locator("myoxus-embed-linked-doc-block")
    .getAttribute("data-block-id");
  expect(linkedDocId).not.toBeNull();

  await switchEditorMode(page);
  await activeNoteInEdgeless(page, noteId);
  const note = await page
    .locator(`myoxus-edgeless-note[data-block-id="${noteId}"]`)
    .boundingBox();
  if (!note) throw new Error("The source Note is not rendered");
  // The destination must be on the Surface, not inside the source Note.
  await dragBlockToPoint(page, linkedDocId!, {
    x: note.x + note.width + 100,
    y: note.y + note.height / 2,
  });

  await waitNextFrame(page);
  await assertParentBlockFlavour(page, linkedDocId!, "myoxus:surface");
});

// Document aliases
test.describe("Customize linked doc title and description", () => {
  // Inline View
  test("should set a custom title for inline link", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusTitle(page);
    await type(page, "title0");
    await focusRichText(page);
    await type(page, "page0");
    await assertRichTexts(page, ["page0"]);

    const { id } = await addNewPage(page);
    await switchToPage(page, id);
    await focusTitle(page);
    await type(page, "title1");
    await focusRichText(page);
    await type(page, "page1");
    await assertRichTexts(page, ["page1"]);

    await focusRichText(page);
    await type(page, "@title0");
    await pressEnter(page);

    const { findRefNode } = getLinkedDocPopover(page);
    const page0 = await findRefNode("title0");
    await page0.hover();

    await waitNextFrame(page, 200);
    const toolbar = page.getByTestId("selection-toolbar");
    await expect(toolbar).toBeVisible();

    const editButton = toolbar.getByRole("button", { name: "Edit" });
    await editButton.click();

    await waitNextFrame(page, 200);
    const popup = page.getByRole("dialog");
    await expect(popup).toBeVisible();

    const input = popup.locator("input");
    await expect(input).toBeFocused();

    // title alias
    await type(page, "page0-title0");
    await pressEnter(page);

    await page.mouse.click(0, 0);

    await focusRichText(page);
    await waitNextFrame(page, 200);

    const page0Alias = await findRefNode("page0-title0");
    await page0Alias.hover();

    await waitNextFrame(page, 200);
    await expect(toolbar).toBeVisible();

    // original title button
    const docTitle = toolbar.getByRole("button", {
      name: "title0",
      exact: true,
    });
    await expect(docTitle).toHaveText("title0", { useInnerText: true });

    // reedit
    await editButton.click();

    await waitNextFrame(page, 200);

    // reset
    await popup.getByRole("button", { name: "Reset" }).click();

    await waitNextFrame(page, 200);

    const resetedPage0 = await findRefNode("title0");
    await resetedPage0.hover();

    await waitNextFrame(page, 200);
    await expect(toolbar).toBeVisible();
    await expect(docTitle).not.toBeVisible();
  });

  // Card View
  test("should set a custom title and description for card link", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusTitle(page);
    await type(page, "title0");

    const { id } = await addNewPage(page);
    await switchToPage(page, id);
    await focusTitle(page);
    await type(page, "title1");

    await focusRichText(page);
    await type(page, "@title0");
    await pressEnter(page);

    const { findRefNode } = getLinkedDocPopover(page);
    const page0 = await findRefNode("title0");
    await page0.hover();

    await waitNextFrame(page, 200);
    const toolbar = page.getByTestId("selection-toolbar");

    let editButton = toolbar.getByRole("button", { name: "Edit" });
    await editButton.click();

    // title alias
    await type(page, "page0-title0");
    await pressEnter(page);

    await focusRichText(page);
    await waitNextFrame(page, 200);

    const page0Alias = await findRefNode("page0-title0");
    await page0Alias.hover();

    await waitNextFrame(page, 200);
    const switchButton = toolbar.getByRole("button", {
      name: "Inline view",
      exact: true,
    });
    await switchButton.click();

    // switches to card view
    const toCardButton = page.getByRole("menuitem", {
      name: "Card view",
      exact: true,
    });
    await toCardButton.click();

    await waitNextFrame(page, 200);
    const linkedDocBlock = page.locator("myoxus-embed-linked-doc-block");
    await expect(linkedDocBlock).toBeVisible();

    const linkedDocBlockTitle = linkedDocBlock.locator(
      ".myoxus-embed-linked-doc-content-title-text",
    );
    await expect(linkedDocBlockTitle).toHaveText("page0-title0");

    await linkedDocBlock.click();

    await waitNextFrame(page, 200);
    const docTitleButton = toolbar.getByRole("button", {
      name: "title0",
      exact: true,
    });
    await expect(docTitleButton).toBeVisible();

    editButton = toolbar.getByRole("button", {
      name: "Edit",
      exact: true,
    });
    await editButton.click();

    await waitNextFrame(page, 200);
    const editModal = page.getByRole("dialog", {
      name: "Edit Description",
      exact: true,
    });
    const resetButton = editModal.getByRole("button", { name: "Reset" });
    const saveButton = editModal.getByRole("button", { name: "Save" });

    // clears aliases
    await resetButton.click();

    await waitNextFrame(page, 200);
    await expect(linkedDocBlockTitle).toHaveText("title0");

    await linkedDocBlock.click();

    await waitNextFrame(page, 200);
    await editButton.click();

    await waitNextFrame(page, 200);

    // title alias
    await type(page, "page0-title0");
    await page.keyboard.press("Tab");
    // description alias
    await type(page, "This is a new description");

    // saves aliases
    await saveButton.click();

    await waitNextFrame(page, 200);
    await expect(linkedDocBlockTitle).toHaveText("page0-title0");
    await expect(
      page.locator(".myoxus-embed-linked-doc-content-note.alias"),
    ).toHaveText("This is a new description");
  });

  // Embed View
  test("should automatically switch to card view and set a custom title and description", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusTitle(page);
    await type(page, "title0");

    const { id } = await addNewPage(page);
    await switchToPage(page, id);
    await focusTitle(page);
    await type(page, "title1");

    await focusRichText(page);
    await type(page, "@title0");
    await pressEnter(page);

    const { findRefNode } = getLinkedDocPopover(page);
    const page0 = await findRefNode("title0");
    await page0.hover();

    await waitNextFrame(page, 200);
    const toolbar = page.getByTestId("selection-toolbar");
    await expect(toolbar).toBeVisible();

    let editButton = toolbar.getByRole("button", { name: "Edit" });
    await editButton.click();

    // title alias
    await type(page, "page0-title0");
    await pressEnter(page);

    await focusRichText(page);
    await waitNextFrame(page, 200);

    const page0Alias = await findRefNode("page0-title0");
    await page0Alias.hover();

    await waitNextFrame(page, 200);
    let switchButton = toolbar.getByRole("button", {
      name: "Inline view",
      exact: true,
    });
    await switchButton.click();

    // switches to card view
    const toCardButton = page.getByRole("menuitem", {
      name: "Card view",
      exact: true,
    });
    await toCardButton.click();

    await waitNextFrame(page, 200);
    const linkedDocBlock = page.locator("myoxus-embed-linked-doc-block");

    await linkedDocBlock.click();

    await waitNextFrame(page, 200);
    const cardToolbar = page.getByTestId("selection-toolbar");
    await expect(cardToolbar).toBeVisible();
    switchButton = cardToolbar.getByRole("combobox", { name: "Switch view" });
    await switchButton.click();

    await waitNextFrame(page, 200);

    // switches to embed view
    const toEmbedButton = page.getByRole("option", {
      name: "Embed view",
      exact: true,
    });
    await toEmbedButton.click();

    await waitNextFrame(page, 200);
    const syncedDocBlock = page.locator("myoxus-embed-synced-doc-block");

    await syncedDocBlock.click();

    await waitNextFrame(page, 200);
    const syncedDocBlockTitle = syncedDocBlock.locator(
      ".myoxus-embed-synced-doc-title",
    );
    await expect(syncedDocBlockTitle).toHaveText("title0");

    await syncedDocBlock.click();

    await waitNextFrame(page, 200);
    editButton = cardToolbar.getByRole("button", {
      name: "Edit",
      exact: true,
    });
    await editButton.click();

    await waitNextFrame(page, 200);
    const editModal = page.getByRole("dialog", {
      name: "Edit Description",
      exact: true,
    });
    const cancelButton = editModal.getByRole("button", { name: "Cancel" });
    const saveButton = editModal.getByRole("button", { name: "Save" });

    // closes edit-model
    await cancelButton.click();

    await waitNextFrame(page, 200);
    await expect(editModal).not.toBeVisible();

    await syncedDocBlock.click();

    await waitNextFrame(page, 200);
    await editButton.click();

    await waitNextFrame(page, 200);

    // title alias
    await type(page, "page0-title0");
    await page.keyboard.press("Tab");
    // description alias
    await type(page, "This is a new description");

    // saves aliases
    await saveButton.click();

    await waitNextFrame(page, 200);

    // automatically switch to card view
    await expect(syncedDocBlock).not.toBeVisible();

    await expect(linkedDocBlock).toBeVisible();
    const linkedDocBlockTitle = linkedDocBlock.locator(
      ".myoxus-embed-linked-doc-content-title-text",
    );
    await expect(linkedDocBlockTitle).toHaveText("page0-title0");
    await expect(
      linkedDocBlock.locator(".myoxus-embed-linked-doc-content-note.alias"),
    ).toHaveText("This is a new description");
  });
});
