import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page } from "@playwright/test";
import { ProjectRoot } from "@myoxus-test/kit/playwright";
import type { BlockSnapshot } from "@virgultum/editor/store";

import { dragBlockToPoint } from "./utils/actions/drag.js";
import { switchEditorMode } from "./utils/actions/edgeless.js";
import {
  pressArrowUp,
  pressBackspace,
  pressEnter,
  pressEscape,
  pressShiftTab,
  pressTab,
  redoByKeyboard,
  type,
  undoByKeyboard,
} from "./utils/actions/keyboard.js";
import {
  captureHistory,
  enterPlaygroundRoom,
  focusRichText,
  getPageSnapshot,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  resetHistory,
  waitNextFrame,
} from "./utils/actions/misc.js";
import {
  assertBlockChildrenIds,
  assertBlockCount,
  assertBlockFlavour,
  assertBlockSelections,
  assertKeyboardWorkInInput,
  assertParentBlockFlavour,
  assertRichImage,
  assertRichTextInlineRange,
} from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

const FILE_NAME = "test-card-1.png";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = ProjectRoot.join(
  "virgultum/integration-test/public",
  FILE_NAME,
).value;
const SHARED_FIXTURE_DIR = path.resolve(__dirname, "../../../shared/fixtures");
const PDF_FILE_PATH = path.join(SHARED_FIXTURE_DIR, "lorem-ipsum.pdf");
const ZIP_FILE_PATH = path.join(
  SHARED_FIXTURE_DIR,
  "v1-color-palettes-snapshot.zip",
);

const FILE_SOURCE_ID = "ejImogf-Tb7AuKY-v94uz1zuOJbClqK-tWBxVr_ksGA=";
const fileCard = (id: string) => ({
  id,
  flavour: "myoxus:attachment",
  props: {
    name: FILE_NAME,
    size: 45801,
    type: "image/png",
    sourceId: FILE_SOURCE_ID,
    embed: false,
  },
});
const paragraph = (id: string, text: string) => ({
  id,
  flavour: "myoxus:paragraph",
  props: { text: { delta: [{ insert: text }] } },
});

async function assertNoteContent(page: Page, expected: object[]) {
  // Protect file identity, content and block order, not unrelated Note theme
  // colors or layout defaults captured by the former whole-document snapshots.
  const root = JSON.parse(await getPageSnapshot(page, true)) as BlockSnapshot;
  const notes = root.children.filter(
    (block) => block.flavour === "myoxus:note",
  );
  expect(notes).toHaveLength(1);
  expect(notes[0].children).toMatchObject(expected);
}

function getAttachment(page: Page) {
  const attachment = page.locator("myoxus-attachment");
  const loading = attachment.locator(".myoxus-attachment-card.loading");
  const toolbar = page.getByTestId("selection-toolbar");
  const switchViewButton = toolbar.getByRole("combobox", {
    name: "Switch view",
  });
  const renameBtn = toolbar.getByRole("button", { name: "Rename" });
  const renameInput = page
    .getByRole("dialog", { name: "Rename", exact: true })
    .getByRole("textbox", { name: "Rename", exact: true });

  const forceFileChooserFallback = async () => {
    await page.evaluate(() => {
      // Force fallback to input[type=file] in tests
      // See https://github.com/microsoft/playwright/issues/8850
      window.showOpenFilePicker = undefined;
    });
  };

  const insertAttachment = async (filePath = FILE_PATH) => {
    await forceFileChooserFallback();

    const slashMenu = page.getByRole("listbox", { name: "Actions" });
    await waitNextFrame(page);
    await type(page, "/");
    await resetHistory(page);
    await expect(slashMenu).toBeVisible();
    await type(page, "attachment", 100);
    const item = slashMenu.getByRole("option", {
      name: "Attachment",
      exact: true,
    });
    await expect(item).toBeVisible();
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      item.click(),
    ]);
    await fileChooser.setFiles(filePath);

    // Try to break the undo redo test
    await captureHistory(page);

    await expect(attachment).toBeVisible();
  };

  const getName = () =>
    attachment.locator(".myoxus-attachment-content-title-text").innerText();

  return {
    // locators
    attachment,
    toolbar,
    switchViewButton,
    renameBtn,
    renameInput,

    // actions
    insertAttachment,
    /**
     * Wait for the attachment upload to finish
     */
    waitLoading: () => loading.waitFor({ state: "hidden" }),
    getName,
    getSize: () =>
      attachment.locator(".myoxus-attachment-content-info").innerText(),

    turnToEmbed: async () => {
      await expect(switchViewButton).toBeVisible();
      await switchViewButton.click();
      await page.getByRole("option", { name: "Embed view" }).click();
      await assertRichImage(page, 1);
    },
    replaceWith: async (filePath: string) => {
      await forceFileChooserFallback();
      const replaceButton = page
        .getByRole("button", { name: "Replace attachment" })
        .last();
      await expect(replaceButton).toBeVisible();
      const fileChooser = page.waitForEvent("filechooser");
      await replaceButton.click();
      await (await fileChooser).setFiles(filePath);
      await expect(loading).toBeHidden();
    },
    rename: async (newName: string) => {
      await attachment.click();
      await expect(toolbar).toBeVisible();
      await renameBtn.click();
      await expect(renameInput).toBeVisible();
      await renameInput.fill(newName);
      await pressEnter(page);
      await expect(renameInput).not.toBeVisible();
      if (newName.length > 0) {
        await expect.poll(getName).toContain(newName);
      }
    },

    // external
    turnImageToCard: async () => {
      await page.locator("myoxus-image").click();
      await expect(
        toolbar.getByRole("button", { name: "Align left", exact: true }),
      ).toBeVisible();
      await toolbar.getByRole("button", { name: "More", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Turn into card view", exact: true })
        .click();
      await expect(attachment).toBeVisible();
    },
  };
}

test("can insert attachment from slash menu", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  const { insertAttachment, waitLoading, getName, getSize } =
    getAttachment(page);

  await focusRichText(page);
  await insertAttachment();

  // Wait for the attachment to be uploaded
  await waitLoading();

  expect(await getName()).toBe(FILE_NAME);
  expect(await getSize()).toBe("44.73KB");

  await assertNoteContent(page, [fileCard("3")]);
});

test("should undo/redo works for attachment", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  const { insertAttachment, waitLoading } = getAttachment(page);

  await focusRichText(page);
  await insertAttachment();

  // Wait for the attachment to be uploaded
  await waitLoading();

  await assertNoteContent(page, [fileCard("3")]);

  await undoByKeyboard(page);
  await page.locator("myoxus-attachment").waitFor({ state: "detached" });

  // The loading/error state should not be restored after undo
  // Slash-menu composition may retain or consume its transient trigger across
  // browser engines. Attachment undo owns the restored block, not that text.
  await assertNoteContent(page, [{ id: "2", flavour: "myoxus:paragraph" }]);

  await redoByKeyboard(page);
  await waitNextFrame(page);

  // The loading/error state should not be restored after undo
  await assertNoteContent(page, [fileCard("3")]);
  await expect(
    page.locator(
      ".myoxus-attachment-card.loading, .myoxus-attachment-card.error",
    ),
  ).toHaveCount(0);
});

test("should rename attachment works", async ({ page }) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/4534",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const {
    attachment,
    renameBtn,
    renameInput,
    insertAttachment,
    waitLoading,
    getName,
    rename,
  } = getAttachment(page);

  await focusRichText(page);
  await insertAttachment();
  // Wait for the attachment to be uploaded
  await waitLoading();

  expect(await getName()).toBe(FILE_NAME);

  await attachment.click();
  await expect(renameBtn).toBeVisible();
  await renameBtn.click();
  await assertKeyboardWorkInInput(page, renameInput);
  await pressEscape(page);
  await expect(renameInput).not.toBeVisible();

  await rename("new-name");
  await expect.poll(getName).toBe("new-name.png");
  await rename("");
  await expect.poll(getName).toBe(".png");
  await rename("abc");
  await expect.poll(getName).toBe("abc");
});

test("should turn attachment to image works", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const {
    attachment,
    insertAttachment,
    waitLoading,
    turnToEmbed,
    turnImageToCard,
  } = getAttachment(page);

  await focusRichText(page);
  await insertAttachment();
  // Wait for the attachment to be uploaded
  await waitLoading();

  await attachment.click();
  await turnToEmbed();

  await assertNoteContent(page, [
    {
      id: "4",
      flavour: "myoxus:image",
      props: {
        sourceId: FILE_SOURCE_ID,
        size: 45801,
        width: 460,
        height: 345,
      },
    },
  ]);

  await turnImageToCard();

  await assertNoteContent(page, [fileCard("5")]);
});

test("can replace attachment in page mode", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const { attachment, insertAttachment, waitLoading, getName, replaceWith } =
    getAttachment(page);

  await focusRichText(page);
  await insertAttachment(PDF_FILE_PATH);
  await waitLoading();
  expect(await getName()).toBe("lorem-ipsum.pdf");

  await attachment.click();
  await replaceWith(ZIP_FILE_PATH);

  await expect.poll(getName).toBe("v1-color-palettes-snapshot.zip");
});

test("falls back to card view when replacing embedded attachment with unsupported file", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const { attachment, insertAttachment, waitLoading, getName, replaceWith } =
    getAttachment(page);

  await focusRichText(page);
  await insertAttachment(PDF_FILE_PATH);
  await waitLoading();
  expect(await getName()).toBe("lorem-ipsum.pdf");

  await attachment.click();
  await page
    .getByRole("combobox", { name: "Switch view", exact: true })
    .click();
  await page.getByRole("option", { name: "Embed view" }).click();
  await expect(attachment.locator("iframe")).toBeVisible();

  await replaceWith(ZIP_FILE_PATH);

  await expect(attachment.locator("iframe")).toBeHidden();
  await expect.poll(getName).toBe("v1-color-palettes-snapshot.zip");
});

test("should attachment can be deleted", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const { attachment, insertAttachment, waitLoading } = getAttachment(page);

  await focusRichText(page);
  await insertAttachment();
  // Wait for the attachment to be uploaded
  await waitLoading();

  await attachment.click();
  await pressBackspace(page);
  await expect(attachment).toHaveCount(0);
  await assertNoteContent(page, []);
});

test(`support dragging attachment block directly`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  const { insertAttachment, waitLoading, getName, getSize } =
    getAttachment(page);

  await focusRichText(page);
  await insertAttachment();

  // Wait for the attachment to be uploaded
  await waitLoading();

  expect(await getName()).toBe(FILE_NAME);
  expect(await getSize()).toBe("44.73KB");

  await assertNoteContent(page, [fileCard("3")]);

  const attachmentBlock = page.locator("myoxus-attachment");
  const rect = await attachmentBlock.boundingBox();
  if (!rect) {
    throw new Error("image not found");
  }

  // Seed the destination content; creating a paragraph by clicking below the
  // card is not part of the attachment drag contract.
  await page.evaluate(() => {
    for (const text of ["111", "222", "333"]) {
      window.doc.addBlock(
        "myoxus:paragraph",
        {
          text: new window.$virgultum.store.Text(text),
        },
        "1",
      );
    }
  });
  await expect(page.locator("myoxus-paragraph")).toHaveCount(3);
  await assertNoteContent(page, [
    fileCard("3"),
    paragraph("4", "111"),
    paragraph("5", "222"),
    paragraph("6", "333"),
  ]);

  // Drag the card to the boundary before the final paragraph.
  const destination = await page.locator('[data-block-id="6"]').boundingBox();
  if (!destination) throw new Error("Attachment drop destination is missing");
  await page.mouse.move(rect.x + 20, rect.y + 20);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, destination.y, {
    steps: 20,
  });
  await page.mouse.up();

  const rects = page.locator(".myoxus-attachment-container.focused");
  await expect(rects).toHaveCount(1);
  await assertNoteContent(page, [
    paragraph("4", "111"),
    paragraph("5", "222"),
    fileCard("3"),
    paragraph("6", "333"),
  ]);
});

test("press backspace after attachment block can select attachment block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const { insertAttachment, waitLoading } = getAttachment(page);

  await focusRichText(page);
  await pressEnter(page);
  await pressArrowUp(page);
  await insertAttachment();
  // Wait for the attachment to be uploaded
  await waitLoading();

  await focusRichText(page);
  await assertBlockCount(page, "paragraph", 1);
  await assertRichTextInlineRange(page, 0, 0);
  await pressBackspace(page);
  await assertBlockSelections(page, ["4"]);
  await assertBlockCount(page, "paragraph", 0);
});

test("indent attachment block to paragraph", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const { insertAttachment, waitLoading } = getAttachment(page);

  await page.evaluate(() => {
    window.doc.addBlock("myoxus:paragraph", {}, "1");
  });
  await focusRichText(page, 1);
  await insertAttachment();
  // Wait for the attachment to be uploaded
  await waitLoading();

  await assertBlockChildrenIds(page, "1", ["2", "4"]);
  await assertBlockFlavour(page, "1", "myoxus:note");
  await assertBlockFlavour(page, "2", "myoxus:paragraph");
  await assertBlockFlavour(page, "4", "myoxus:attachment");

  await page.locator("myoxus-attachment").click();
  await assertBlockSelections(page, ["4"]);
  await pressTab(page);
  await assertBlockChildrenIds(page, "1", ["2"]);
  await assertBlockChildrenIds(page, "2", ["4"]);

  await pressShiftTab(page);
  await assertBlockChildrenIds(page, "1", ["2", "4"]);
});

test("indent attachment block to list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const { insertAttachment, waitLoading } = getAttachment(page);

  await focusRichText(page);
  await type(page, "- a");
  await pressEnter(page);
  await insertAttachment();
  // Wait for the attachment to be uploaded
  await waitLoading();

  await assertBlockChildrenIds(page, "1", ["3", "5"]);
  await assertBlockFlavour(page, "1", "myoxus:note");
  await assertBlockFlavour(page, "3", "myoxus:list");
  await assertBlockFlavour(page, "5", "myoxus:attachment");

  await page.locator("myoxus-attachment").click();
  await assertBlockSelections(page, ["5"]);
  await pressTab(page);
  await assertBlockChildrenIds(page, "1", ["3"]);
  await assertBlockChildrenIds(page, "3", ["5"]);

  await pressShiftTab(page);
  await assertBlockChildrenIds(page, "1", ["3", "5"]);
});

test("attachment can be dragged from note to surface top level block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  const { insertAttachment, waitLoading } = getAttachment(page);

  await focusRichText(page);
  await insertAttachment();

  // Wait for the attachment to be uploaded
  await waitLoading();

  await switchEditorMode(page);
  // The Note mask owns the opening gesture; the inner card is intentionally
  // not a pointer target until the Note enters edit mode.
  const card = await page.locator("myoxus-attachment").boundingBox();
  if (!card) throw new Error("Attachment card is missing");
  await page.mouse.dblclick(card.x + card.width / 2, card.y + card.height / 2);
  await page.locator("myoxus-attachment").hover();
  await expect(page.locator(".myoxus-drag-handle-container")).toBeVisible();

  await dragBlockToPoint(page, "4", { x: 200, y: 200 });

  await waitNextFrame(page);
  await assertParentBlockFlavour(page, "4", "myoxus:surface");
});
