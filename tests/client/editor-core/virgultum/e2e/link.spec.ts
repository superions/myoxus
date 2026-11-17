import { expect, type Page } from "@playwright/test";

import {
  cutByKeyboard,
  dragBetweenIndices,
  enterPlaygroundRoom,
  focusRichText,
  getTextOperationSnapshot,
  initEmptyParagraphState,
  pasteByKeyboard,
  pressEnter,
  selectAllByKeyboard,
  SHORT_KEY,
  switchReadonly,
  type,
} from "./utils/actions/index.js";
import { assertKeyboardWorkInInput } from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

const pressCreateLinkShortCut = async (page: Page) => {
  await page.keyboard.press(`${SHORT_KEY}+k`);
};

test("basic link", async ({ page }, testInfo) => {
  const linkText = "linkText";
  const link = "http://example.com";
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, linkText);

  // Create link
  await dragBetweenIndices(page, [0, 0], [0, 8]);
  await pressCreateLinkShortCut(page);
  await page.mouse.move(0, 0);

  const createLinkPopoverLocator = page.getByRole("dialog", {
    name: "Link",
    exact: true,
  });
  await expect(createLinkPopoverLocator).toBeVisible();
  const linkPopoverInput = page.getByRole("textbox", {
    name: "Link",
    exact: true,
  });
  await expect(linkPopoverInput).toBeVisible();
  await type(page, link);
  await pressEnter(page);
  await expect(createLinkPopoverLocator).not.toBeVisible();

  const linkLocator = page.locator("myoxus-link a");
  await expect(linkLocator).toHaveAttribute("href", link);

  // clear text selection
  await page.keyboard.press("ArrowLeft");

  const toolbar = page.getByTestId("selection-toolbar");
  // Hover link
  await expect(toolbar).not.toBeVisible();
  await linkLocator.hover();
  // wait for popover delay open
  await page.waitForTimeout(200);
  await expect(toolbar).toBeVisible();

  // Edit link
  const text2 = "link2";
  const link2 = "https://github.com";
  const editLinkBtn = toolbar.getByRole("button", {
    name: "Edit Description",
    exact: true,
  });
  await editLinkBtn.click();

  const editLinkPopoverLocator = page.getByRole("dialog", {
    name: "Link",
    exact: true,
  });
  await expect(editLinkPopoverLocator).toBeVisible();
  await editLinkPopoverLocator
    .getByRole("textbox", { name: "Text", exact: true })
    .fill(text2);
  await editLinkPopoverLocator
    .getByRole("textbox", { name: "Link", exact: true })
    .fill(link2);
  await editLinkPopoverLocator
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const link2Locator = page.locator("myoxus-link a");

  await expect(link2Locator).toHaveAttribute("href", link2);
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
});

test("add link when dragging from empty line", async ({ page }) => {
  const linkText = "linkText\n\n";
  const link = "http://example.com";
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, linkText);

  // Create link
  await dragBetweenIndices(page, [2, 0], [0, 0], {
    x: 1,
    y: 2,
  });
  await pressCreateLinkShortCut(page);
  await page.mouse.move(0, 0);

  const createLinkPopoverLocator = page.getByRole("dialog", {
    name: "Link",
    exact: true,
  });
  await expect(createLinkPopoverLocator).toBeVisible();
  const linkPopoverInput = page.getByRole("textbox", {
    name: "Link",
    exact: true,
  });
  await expect(linkPopoverInput).toBeVisible();
  await type(page, link);
  await pressEnter(page);
  await expect(createLinkPopoverLocator).not.toBeVisible();

  const linkLocator = page.locator("myoxus-link a");
  await expect(linkLocator).toHaveAttribute("href", link);
});

async function createLinkBlock(page: Page, str: string, link: string) {
  const id = await page.evaluate(
    ([str, link]) => {
      const { doc } = window;
      const rootId =
        doc.root?.id ??
        doc.addBlock("myoxus:page", {
          title: new window.$virgultum.store.Text("title"),
        });
      const noteId = doc.addBlock("myoxus:note", {}, rootId);
      const title = (
        doc.getBlock(rootId)!
          .model as import("@virgultum/core/models").RootBlockModel
      ).props.title;
      title.clear();
      title.insert("title", 0);

      const text = new window.$virgultum.store.Text([
        { insert: "Hello" },
        { insert: str, attributes: { link } },
      ]);
      const id = doc.addBlock(
        "myoxus:paragraph",
        { type: "text", text: text },
        noteId,
      );
      return id;
    },
    [str, link],
  );
  return id;
}

test("type character in link should not jump out link node", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await createLinkBlock(page, "link text", "http://example.com");
  await focusRichText(page, 0);
  await page.keyboard.press("ArrowLeft");
  await type(page, "IN_LINK");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
});

test("type character after link should not extend the link attributes", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await createLinkBlock(page, "link text", "http://example.com");
  await focusRichText(page, 0);
  await type(page, "AFTER_LINK");
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
});

test("readonly mode should not trigger toolbar", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const linkText = "linkText";
  await createLinkBlock(page, "linkText", "http://example.com");
  await focusRichText(page, 0);
  const linkLocator = page.locator(`text="${linkText}"`);

  // Hover link
  const toolbar = page.getByTestId("selection-toolbar");
  await linkLocator.hover();
  await expect(toolbar).toBeVisible();

  await switchReadonly(page);

  await page.mouse.move(0, 0);
  // XXX Wait for readonly delay
  await page.waitForTimeout(300);

  await linkLocator.hover();
  await expect(toolbar).not.toBeVisible();

  // ---
  // press hotkey should not trigger create link popup

  await dragBetweenIndices(page, [0, 0], [0, 3]);
  await pressCreateLinkShortCut(page);

  await expect(toolbar).not.toBeVisible();
  const linkPopoverInput = page.getByRole("textbox", {
    name: "Link",
    exact: true,
  });
  await expect(linkPopoverInput).not.toBeVisible();
});

test("should mock selection not stored", async ({ page }, testInfo) => {
  const linkText = "linkText";
  const link = "http://example.com";
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, linkText);

  // Create link
  await dragBetweenIndices(page, [0, 0], [0, 8]);
  await pressCreateLinkShortCut(page);

  const popupHighlight = () =>
    page.evaluate(() => CSS.highlights.get("myoxus-inline-popup")?.size ?? 0);
  await expect.poll(popupHighlight).toBe(1);

  // the mock select node should not be stored in the Y doc
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );

  await type(page, link);
  await pressEnter(page);

  // the mock select node should be removed after link created
  await expect.poll(popupHighlight).toBe(0);
});

test("should keyboard work in link popover", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const linkText = "linkText";
  await createLinkBlock(page, linkText, "http://example.com");

  await dragBetweenIndices(page, [0, 0], [0, 8]);
  await pressCreateLinkShortCut(page);
  const linkPopoverInput = page.getByRole("textbox", {
    name: "Link",
    exact: true,
  });
  await assertKeyboardWorkInInput(page, linkPopoverInput);
  await page.keyboard.press("Escape");
  await expect(linkPopoverInput).toBeHidden();

  const toolbar = page.getByTestId("selection-toolbar");
  const linkLocator = page.locator(`text="${linkText}"`);

  await focusRichText(page);
  // hover link
  await page.keyboard.press("ArrowRight");
  await page.mouse.move(0, 0);
  await linkLocator.hover();
  // wait for popover delay open
  await page.waitForTimeout(500);
  await expect(toolbar).toBeVisible();

  const editLinkBtn = toolbar.getByRole("button", {
    name: "Edit Description",
    exact: true,
  });
  await editLinkBtn.click();

  const editLinkPopover = page.getByRole("dialog", {
    name: "Link",
    exact: true,
  });
  await expect(editLinkPopover).toBeVisible();

  const editTextInput = editLinkPopover.getByRole("textbox", {
    name: "Text",
    exact: true,
  });
  await assertKeyboardWorkInInput(page, editTextInput);
  const editLinkInput = editLinkPopover.getByRole("textbox", {
    name: "Link",
    exact: true,
  });
  await assertKeyboardWorkInInput(page, editLinkInput);
});

test("link bar should not be appear when the range is collapsed", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaa");

  await pressCreateLinkShortCut(page);
  const linkPopoverLocator = page.getByRole("dialog", {
    name: "Link",
    exact: true,
  });
  await expect(linkPopoverLocator).not.toBeVisible();

  await dragBetweenIndices(page, [0, 0], [0, 3]);
  await pressCreateLinkShortCut(page);
  await expect(linkPopoverLocator).toBeVisible();
});

test("create link with paste", async ({ page }, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "aaa");

  await dragBetweenIndices(page, [0, 0], [0, 3]);
  await pressCreateLinkShortCut(page);

  const createLinkPopoverLocator = page.getByRole("dialog", {
    name: "Link",
    exact: true,
  });
  const confirmBtn = createLinkPopoverLocator.getByRole("button", {
    name: "Save",
    exact: true,
  });

  await expect(createLinkPopoverLocator).toBeVisible();
  await expect(confirmBtn).toBeDisabled();

  await type(page, "example.com");
  await expect(confirmBtn).not.toHaveAttribute("disabled");
  await selectAllByKeyboard(page);
  await cutByKeyboard(page);

  // press enter should not trigger confirm
  await pressEnter(page);
  await expect(createLinkPopoverLocator).toBeVisible();
  await expect(confirmBtn).toBeDisabled();

  await pasteByKeyboard(page, false);
  await expect(confirmBtn).not.toHaveAttribute("disabled");
  await pressEnter(page);
  await expect(createLinkPopoverLocator).not.toBeVisible();
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
});
