import { lightTheme } from "@myoxus/theme";
import { expect } from "@playwright/test";

import {
  activeNoteInEdgeless,
  addNote,
  assertEdgelessTool,
  changeEdgelessNoteBackground,
  changeNoteDisplayMode,
  dragBetweenViewCoords,
  getSelectedBound,
  getNoteRect,
  getNoteBoundBoxInEdgeless,
  getSelectedBoundCount,
  locatorComponentToolbar,
  resizeElementByHandle,
  selectNoteInEdgeless,
  setEdgelessTool,
  setViewportCenter,
  switchEditorMode,
  triggerComponentToolbarAction,
  zoomOutByKeyboard,
  zoomResetByKeyboard,
} from "../../utils/actions/edgeless.js";
import {
  clickBlockById,
  clickView,
  dragBetweenCoords,
  dragBetweenIndices,
  enterPlaygroundRoom,
  focusRichText,
  focusRichTextEnd,
  initEmptyEdgelessState,
  initThreeParagraphs,
  pressArrowDown,
  pressArrowUp,
  pressBackspace,
  pressEnter,
  pressEscape,
  pressTab,
  selectAllByKeyboard,
  type,
  undoByKeyboard,
  waitForInlineEditorStateUpdated,
  waitNextFrame,
} from "../../utils/actions/index.js";
import {
  assertBlockChildrenIds,
  assertBlockCount,
  assertEdgelessNoteBackground,
  assertEdgelessSelectedRect,
  assertNoteSequence,
  assertNoteXYWH,
  assertRichTextInlineRange,
  assertRichTexts,
  assertTextSelection,
} from "../../utils/asserts.js";
import {
  DEFAULT_NOTE_WIDTH,
  NoteDisplayMode,
} from "../../utils/bs-alternative.js";
import { test } from "../../utils/playwright.js";

const CENTER_X = 450;
const CENTER_Y = 450;

test("can drag selected non-active note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await focusRichText(page);
  await type(page, "hello");
  await assertRichTexts(page, ["hello"]);

  await switchEditorMode(page);
  await zoomResetByKeyboard(page);
  const { h } = await getNoteRect(page, noteId);
  await assertNoteXYWH(page, [0, 0, DEFAULT_NOTE_WIDTH, h]);

  // selected, non-active
  const box = await getNoteBoundBoxInEdgeless(page, noteId);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(point.x, point.y);
  await dragBetweenCoords(page, point, { x: point.x, y: point.y + 100 });
  await assertNoteXYWH(page, [0, 100, DEFAULT_NOTE_WIDTH, h]);

  await undoByKeyboard(page);
  await waitNextFrame(page);
  await assertNoteXYWH(page, [0, 0, DEFAULT_NOTE_WIDTH, h]);
});

test("add Note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);

  await switchEditorMode(page);
  await zoomResetByKeyboard(page);
  const noteId = await addNote(page, "hello", 300, 300);

  await assertEdgelessTool(page, "default");
  await assertRichTexts(page, ["", "hello"]);
  await page.mouse.click(300, 200);
  await page.mouse.click(350, 320);
  await assertEdgelessSelectedRect(page, [
    270,
    260,
    DEFAULT_NOTE_WIDTH,
    (await getNoteRect(page, noteId)).h,
  ]);
});

test("add empty Note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);

  await switchEditorMode(page);
  await zoomResetByKeyboard(page);
  await setEdgelessTool(page, "note");
  // add note at 300,300
  await page.mouse.click(300, 300);
  await waitForInlineEditorStateUpdated(page);
  // should wait for inline editor update and resizeObserver callback
  await waitNextFrame(page);

  // assert add note success
  await assertBlockCount(page, "edgeless-note", 2);

  // click out of note
  await page.mouse.click(250, 200);

  // assert empty note is note removed
  await page.mouse.move(320, 320);
  await assertBlockCount(page, "edgeless-note", 2);
});

test("edgeless arrow up/down", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { paragraphId, noteId } = await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  await activeNoteInEdgeless(page, noteId);
  await waitNextFrame(page, 400);

  await type(page, "aaaaa");
  await pressEnter(page);
  await type(page, "aaaaa");
  await pressEnter(page);
  await type(page, "aaa");

  await waitForInlineEditorStateUpdated(page);
  // 0 for page, 1 for surface, 2 for note, 3 for paragraph
  expect(paragraphId).toBe("3");
  await clickBlockById(page, paragraphId);
  await assertRichTextInlineRange(page, 0, 5, 0);

  await pressArrowDown(page);
  await waitNextFrame(page);
  await assertRichTextInlineRange(page, 1, 5, 0);

  await pressArrowUp(page);
  await waitNextFrame(page);
  await assertRichTextInlineRange(page, 0, 5, 0);

  await pressArrowUp(page);
  await waitNextFrame(page);
  await assertRichTextInlineRange(page, 0, 0, 0);
});

test("format quick bar should show up when double-clicking on text", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await initThreeParagraphs(page);
  await switchEditorMode(page);

  await activeNoteInEdgeless(page, noteId);
  await waitNextFrame(page);

  await page
    .locator("rich-text")
    .nth(1)
    .dblclick({
      position: { x: 10, y: 10 },
      delay: 20,
    });
  await page.waitForTimeout(200);
  const formatBar = page.getByTestId("selection-toolbar");
  await expect(formatBar).toBeVisible();
});

test("when editing text in edgeless, should hide component toolbar", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await initThreeParagraphs(page);
  await switchEditorMode(page);

  await selectNoteInEdgeless(page, noteId);

  const toolbar = locatorComponentToolbar(page);
  await expect(toolbar).toBeVisible();

  await page.mouse.click(0, 0);
  await activeNoteInEdgeless(page, noteId);
  await expect(toolbar).toBeHidden();
});

test("duplicate note should work correctly", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await initThreeParagraphs(page);
  await assertRichTexts(page, ["123", "456", "789"]);

  await switchEditorMode(page);

  await selectNoteInEdgeless(page, noteId);

  await triggerComponentToolbarAction(page, "duplicate");
  await waitNextFrame(page, 200); // wait viewport fit animation
  const moreActionsContainer = page.getByLabel("More menu").getByRole("menu");
  await expect(moreActionsContainer).toBeHidden();

  const noteLocator = page.locator("myoxus-edgeless-note");
  await expect(noteLocator).toHaveCount(2);
  const [firstNote, secondNote] = await noteLocator.all();

  // content should be same
  expect(await firstNote.innerText()).toEqual(await secondNote.innerText());

  // size should be same
  const firstNoteBox = await firstNote.boundingBox();
  const secondNoteBox = await secondNote.boundingBox();
  expect(firstNoteBox!.width).toBeCloseTo(secondNoteBox!.width);
  expect(firstNoteBox!.height).toBeCloseTo(secondNoteBox!.height);
});

test("change note color", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await initThreeParagraphs(page);
  await switchEditorMode(page);

  await assertEdgelessNoteBackground(
    page,
    noteId,
    lightTheme.noteBackgroundWhite,
  );

  await selectNoteInEdgeless(page, noteId);
  await triggerComponentToolbarAction(page, "changeNoteStyle");
  await changeEdgelessNoteBackground(page, "Green");
  await assertEdgelessNoteBackground(
    page,
    noteId,
    lightTheme.noteBackgroundGreen,
  );
});

test("cursor for active and inactive state", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await focusRichText(page);
  await type(page, "hello");
  await pressEnter(page);
  await pressEnter(page);
  await assertRichTexts(page, ["hello", "", ""]);

  await switchEditorMode(page);

  await page.mouse.click(CENTER_X, CENTER_Y);
  await waitNextFrame(page);
  await assertTextSelection(page);
  await page.mouse.dblclick(CENTER_X, CENTER_Y);
  await waitNextFrame(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(window.host.selection.value.find((s) => s.type === "text")),
      ),
    )
    .toBe(true);
});

test("when no visible note block, clicking in page mode will auto add a new note block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await page.evaluate(() => {
    window.doc
      .get(window.$virgultum.services.FeatureFlagService)
      .setFlag("enable_advanced_block_visibility", true);
  });
  await switchEditorMode(page);

  await assertBlockCount(page, "edgeless-note", 1);
  // select note
  await selectNoteInEdgeless(page, "2");
  await assertNoteSequence(page, "1");
  await assertBlockCount(page, "edgeless-note", 1);
  // hide note
  await triggerComponentToolbarAction(page, "changeNoteDisplayMode");
  await waitNextFrame(page);
  await changeNoteDisplayMode(page, NoteDisplayMode.EdgelessOnly);

  await switchEditorMode(page);
  let note = await page.evaluate(() => {
    return document.querySelector("myoxus-note");
  });
  expect(note).toBeNull();
  const viewport = page.locator(".myoxus-page-viewport");
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  await viewport.click({
    position: { x: box!.width / 2, y: box!.height - 20 },
  });
  await expect(page.locator("myoxus-note")).toHaveCount(1);
});

test("Should focus at closest text block when note collapse", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);

  // Make sure there is no rich text content
  await switchEditorMode(page);
  await zoomResetByKeyboard(page);
  await assertRichTexts(page, [""]);

  // Select the note
  await zoomOutByKeyboard(page);
  const notePortalBox = await page
    .locator("myoxus-edgeless-note")
    .boundingBox();
  if (!notePortalBox) {
    throw new Error("notePortalBox is not found");
  }
  await page.mouse.click(notePortalBox.x + 10, notePortalBox.y + 10);
  await waitNextFrame(page, 200);
  const selectedRect = page
    .locator("edgeless-selected-rect")
    .locator(".myoxus-edgeless-selected-rect");
  await expect(selectedRect).toBeVisible();

  // Collapse the note
  const selectedBox = await selectedRect.boundingBox();
  if (!selectedBox) {
    throw new Error("selectedBox is not found");
  }
  await page.mouse.move(
    selectedBox.x + selectedBox.width / 2,
    selectedBox.y + selectedBox.height,
  );
  await page.mouse.down();
  await page.mouse.move(
    selectedBox.x + selectedBox.width / 2,
    selectedBox.y + selectedBox.height + 200,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect(selectedRect).toBeVisible();

  // Click at the bottom of note to focus at the closest text block
  await page.mouse.click(
    selectedBox.x + selectedBox.width / 2,
    selectedBox.y + selectedBox.height - 20,
  );
  await waitNextFrame(page, 200);

  // Should be enter edit mode and there are no selected rect
  await expect(selectedRect).toBeHidden();

  // Focus at the closest text block and make sure can type
  await type(page, "hello");
  await waitNextFrame(page, 200);
  await assertRichTexts(page, ["hello"]);
});

test("delete first block in edgeless note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  await zoomResetByKeyboard(page);
  await assertNoteXYWH(page, [
    0,
    0,
    DEFAULT_NOTE_WIDTH,
    (await getNoteRect(page, noteId)).h,
  ]);
  await activeNoteInEdgeless(page, noteId);

  // first block without children, nothing should happen
  await assertRichTexts(page, [""]);
  await assertBlockChildrenIds(page, "3", []);
  await pressBackspace(page);

  await type(page, "aaa");
  await pressEnter(page);
  await type(page, "bbb");
  await pressTab(page);
  await assertRichTexts(page, ["aaa", "bbb"]);
  await assertBlockChildrenIds(page, "3", ["4"]);

  // first block with children, need to bring children to parent
  await focusRichTextEnd(page);
  await pressBackspace(page, 3);
  await assertRichTexts(page, ["", "bbb"]);
  await pressBackspace(page);
  await assertRichTexts(page, ["bbb"]);
  await assertBlockChildrenIds(page, "4", []);
});

test("select text cross blocks in edgeless note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  await activeNoteInEdgeless(page, noteId);
  await waitNextFrame(page, 400);

  await type(page, "aaa");
  await pressEnter(page);
  await type(page, "bbb");
  await pressEnter(page);
  await type(page, "ccc");
  await assertRichTexts(page, ["aaa", "bbb", "ccc"]);

  await dragBetweenIndices(page, [0, 1], [2, 2]);
  await pressBackspace(page);
  await assertRichTexts(page, ["ac"]);
});

test("should not select doc only note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await page.evaluate(() => {
    window.doc
      .get(window.$virgultum.services.FeatureFlagService)
      .setFlag("enable_advanced_block_visibility", true);
  });
  await switchEditorMode(page);
  await clickView(page, [0, 0]);

  await selectAllByKeyboard(page);
  const noteBound = await getSelectedBound(page);

  await triggerComponentToolbarAction(page, "changeNoteDisplayMode");
  await waitNextFrame(page);
  await changeNoteDisplayMode(page, NoteDisplayMode.DocOnly);

  await selectAllByKeyboard(page);
  expect(await getSelectedBoundCount(page)).toBe(0);

  await clickView(page, [
    0.5 * (noteBound[0] + noteBound[2]),
    0.5 * (noteBound[1] + noteBound[3]),
  ]);
  expect(await getSelectedBoundCount(page)).toBe(0);

  await dragBetweenViewCoords(
    page,
    [noteBound[0] - 10, noteBound[1] - 10],
    [noteBound[0] + noteBound[2] + 10, noteBound[1] + noteBound[3] + 10],
  );
  expect(await getSelectedBoundCount(page)).toBe(0);
});

test.describe("visibility of hidden content of edgeless note", () => {
  test.beforeEach(async ({ page }) => {
    await enterPlaygroundRoom(page);
    const { noteId } = await initEmptyEdgelessState(page);
    await switchEditorMode(page);

    const note = page.locator("myoxus-edgeless-note");
    await note.click({ clickCount: 3 });
    await type(page, "hello");
    await pressEnter(page, 12);
    await type(page, "world");
    await pressEscape(page, 3);

    const rect = await getNoteRect(page, noteId);
    await setViewportCenter(page, [rect.x + rect.w / 2, rect.y + rect.h / 2]);

    await note.click();
    await resizeElementByHandle(page, { x: 0, y: -200 }, "bottom-right");
  });

  test("should hide content when note is not selected or hovered when selected", async ({
    page,
  }) => {
    const note = page.locator("myoxus-edgeless-note");
    const lastParagraph = page.locator("myoxus-paragraph").last();

    await pressEscape(page, 3);
    await page.mouse.move(900, 800);
    await expect(lastParagraph).not.toBeInViewport();

    const noteBound = await note.boundingBox();
    if (!noteBound) {
      test.fail();
      return;
    }
    await note.click();
    // move out to right side
    await page.mouse.move(
      noteBound.x + noteBound.width + 10,
      noteBound.y + noteBound.height - 10,
    );
    await expect(lastParagraph).not.toBeInViewport();
  });

  test("should show hidden content when hover on selected note", async ({
    page,
  }) => {
    const note = page.locator("myoxus-edgeless-note");
    const lastParagraph = page.locator("myoxus-paragraph").last();

    const noteBound = await note.boundingBox();
    if (!noteBound) {
      test.fail();
      return;
    }

    // move in right side
    await page.mouse.move(
      noteBound.x + noteBound.width - 10,
      noteBound.y + noteBound.height - 10,
    );
    await expect(lastParagraph).toBeInViewport();

    // move to hidden content
    await page.mouse.move(
      noteBound.x + noteBound.width - 10,
      noteBound.y + noteBound.height + 100,
    );
    await expect(lastParagraph).toBeInViewport();
  });

  test("should show hidden content when the note is being edited", async ({
    page,
  }) => {
    const note = page.locator("myoxus-edgeless-note");
    const lastParagraph = page.locator("myoxus-paragraph").last();

    await note.click({ clickCount: 3 });
    await page.locator("myoxus-paragraph").nth(2).click();
    await type(page, "test");

    await expect(lastParagraph).toBeInViewport();

    await note.click({ clickCount: 3 });
    await page.locator("myoxus-paragraph").nth(2).click();

    const noteBound = await note.boundingBox();
    if (!noteBound) {
      test.fail();
      return;
    }
    await page.mouse.move(
      noteBound.x + noteBound.width - 10,
      noteBound.y + noteBound.height - 10,
    );
    await expect(lastParagraph).toBeInViewport();

    await note.click({ clickCount: 3 });
    await page.locator("myoxus-paragraph").nth(2).click();

    await page.mouse.wheel(0, 200);
    await expect(
      lastParagraph,
      "editing note but out of viewport should also show hidden content",
    ).toBeInViewport();
  });
});
