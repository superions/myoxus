import { expect } from "@playwright/test";

import { addNote, switchEditorMode } from "./utils/actions/edgeless.js";
import {
  pressArrowDown,
  pressArrowLeft,
  pressArrowRight,
  pressArrowUp,
  pressBackspace,
  pressEnter,
  pressEscape,
  pressShiftEnter,
  pressShiftTab,
  pressTab,
  redoByKeyboard,
  SHORT_KEY,
  type,
  undoByKeyboard,
} from "./utils/actions/keyboard.js";
import {
  captureHistory,
  enterPlaygroundRoom,
  focusRichText,
  getInlineSelectionText,
  getTextOperationSnapshot,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  insertThreeLevelLists,
  waitNextFrame,
} from "./utils/actions/misc.js";
import { assertRichTexts } from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

function formatWithTimezone(date: Date, timeZone: string = "Asia/Tokyo") {
  const tokyoDate = date.toLocaleString("en-US", { timeZone });
  const year = tokyoDate.split(",")[0].split("/")[2];
  const month = tokyoDate.split(",")[0].split("/")[0].padStart(2, "0");
  const day = tokyoDate.split(",")[0].split("/")[1].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("slash menu should show and hide correctly", () => {
  test.beforeEach(async ({ page }) => {
    await enterPlaygroundRoom(page);
  });

  test("slash menu should show when user inserts Japanese enumeration comma", async ({
    page,
  }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await page.keyboard.insertText("、");

    await expect(slashMenu).toBeVisible();
  });

  test("slash menu should hide after click away", async ({
    page,
  }, testInfo) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    // Click outside should close slash menu
    await page.mouse.click(0, 50);
    await expect(slashMenu).toBeHidden();

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
  });

  test("slash menu should hide after input whitespace", async ({ page }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await type(page, " ");
    await expect(slashMenu).toBeHidden();
    await assertRichTexts(page, ["/ "]);
    await pressBackspace(page);
    await expect(slashMenu).toBeVisible();

    await type(page, "head");
    await expect(slashMenu).toBeVisible();
    await type(page, " ");
    await expect(slashMenu).toBeHidden();
    await pressBackspace(page);
    await expect(slashMenu).toBeVisible();
  });

  test("delete the slash symbol should close the slash menu", async ({
    page,
  }, testInfo) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    await pressBackspace(page);
    await expect(slashMenu).toBeHidden();
    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
  });

  test("shows an empty state and recovers when deleting an unmatched query", async ({
    page,
  }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    await type(page, "_");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("No results found");
    await assertRichTexts(page, ["/_"]);

    // And pressing backspace immediately should reappear the slash menu
    await pressBackspace(page);
    await expect(slashMenu).toBeVisible();

    await type(page, "__");
    await pressBackspace(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("No results found");
  });

  test("pressing the slash key again should close the old slash menu and open new one", async ({
    page,
  }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toHaveCount(1);
    await assertRichTexts(page, ["//"]);
  });

  test("should move up down with arrow key", async ({ page }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    const slashItems = slashMenu.getByRole("option");

    await pressArrowDown(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.nth(1)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(1)).toHaveText(["Heading 1"]);
    await assertRichTexts(page, ["/"]);

    await pressArrowUp(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.first()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.first()).toHaveText(["Text"]);
    await assertRichTexts(page, ["/"]);

    await pressArrowUp(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.last()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.last()).toHaveText(["Delete"]);
    await assertRichTexts(page, ["/"]);

    await pressArrowDown(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.first()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.first()).toHaveText(["Text"]);
    await assertRichTexts(page, ["/"]);
  });

  test("slash menu hover state", async ({ page }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    const slashItems = slashMenu.getByRole("option");

    await pressArrowDown(page);
    await expect(slashItems.nth(1)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );

    await pressArrowUp(page);
    await expect(slashItems.nth(1)).not.toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(0)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );

    await pressArrowDown(page);
    await pressArrowDown(page);
    await expect(slashItems.nth(2)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(1)).not.toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(0)).not.toHaveAttribute(
      "data-combobox-selected",
      "true",
    );

    await slashItems.nth(0).hover();
    await expect(slashItems.nth(0)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(2)).not.toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(1)).not.toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
  });

  test("press tab should move up and down", async ({ page }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    const slashItems = slashMenu.getByRole("option");

    await pressTab(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.nth(1)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(1)).toHaveText(["Heading 1"]);
    await assertRichTexts(page, ["/"]);

    await pressShiftTab(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.first()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.first()).toHaveText(["Text"]);
    await assertRichTexts(page, ["/"]);

    await pressShiftTab(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.last()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.last()).toHaveText(["Delete"]);
    await assertRichTexts(page, ["/"]);

    await pressTab(page);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.first()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.first()).toHaveText(["Text"]);
    await assertRichTexts(page, ["/"]);
  });

  test("should move up down with ctrl/cmd+n and ctrl/cmd+p", async ({
    page,
  }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    const slashItems = slashMenu.getByRole("option");

    await page.keyboard.press(`${SHORT_KEY}+n`);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.nth(1)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(1)).toHaveText(["Heading 1"]);
    await assertRichTexts(page, ["/"]);

    await page.keyboard.press(`${SHORT_KEY}+p`);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.first()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.first()).toHaveText(["Text"]);
    await assertRichTexts(page, ["/"]);

    await page.keyboard.press(`${SHORT_KEY}+p`);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.last()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.last()).toHaveText(["Delete"]);
    await assertRichTexts(page, ["/"]);

    await page.keyboard.press(`${SHORT_KEY}+n`);
    await expect(slashMenu).toBeVisible();
    await expect(slashItems.first()).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.first()).toHaveText(["Text"]);
    await assertRichTexts(page, ["/"]);
  });

  test("opens a submenu by pointer and returns to its parent", async ({
    page,
  }) => {
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "/");
    const menu = page.getByTestId("slash-menu");
    await menu
      .getByRole("option", { name: "Other Headings", exact: true })
      .click();
    await expect(menu).toHaveAttribute("data-depth", "1");
    await expect(menu.getByRole("option").first()).toHaveText("Heading 4");
    await page.getByRole("button", { name: /Back/ }).click();
    await expect(menu).toHaveAttribute("data-depth", "0");
  });

  test("navigate menu with left right arrow and Enter", async ({ page }) => {
    await initEmptyParagraphState(page);
    await focusRichText(page);

    const slashMenu = page.getByTestId("slash-menu");

    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await pressEscape(page);
    await expect(slashMenu).toBeHidden();

    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await pressArrowLeft(page);
    await expect(
      slashMenu,
      "root menu should be visible when press arrow left",
    ).toBeVisible();
    await pressEscape(page);

    // Test sub menu case
    const slashItems = slashMenu.getByRole("option");

    await type(page, "/");
    await slashMenu.waitFor({ state: "visible" });
    await pressArrowDown(page, 4);
    await expect(slashItems.nth(4)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(4)).toHaveText(["Other Headings"]);

    const subMenu = page.locator('[data-testid="slash-menu"][data-depth="1"]');

    await pressArrowRight(page);
    await expect(slashMenu).toBeVisible();
    await expect(subMenu).toBeVisible();

    await pressArrowLeft(page);
    await expect(slashMenu).toBeVisible();
    await expect(subMenu).toBeHidden();

    await pressEnter(page);
    await expect(slashMenu).toBeVisible();
    await expect(subMenu).toBeVisible();
  });

  test("menu should be hidden when press escape", async ({ page }) => {
    await initEmptyParagraphState(page);
    await focusRichText(page);

    const slashMenu = page.getByTestId("slash-menu");

    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await pressEscape(page);
    await expect(slashMenu).toBeHidden();

    // go to sub menu
    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await pressArrowDown(page, 4);
    await pressArrowRight(page);
    await expect(slashMenu).toBeVisible();
    const subMenu = page.locator('[data-testid="slash-menu"][data-depth="1"]');
    await expect(subMenu).toBeVisible();
    await pressEscape(page);
    await expect(slashMenu).toBeVisible();
    await expect(subMenu).toBeHidden();
    await pressEscape(page);
    await expect(slashMenu).toBeHidden();
  });

  test("show close current all submenu when typing", async ({ page }) => {
    await initEmptyParagraphState(page);
    await focusRichText(page);

    const slashMenu = page.getByTestId("slash-menu");
    const subMenu = page.locator('[data-testid="slash-menu"][data-depth="1"]');
    const slashItems = slashMenu.getByRole("option");

    await type(page, "/");
    await expect(slashMenu).toBeVisible();
    await pressArrowDown(page, 4);
    await expect(slashItems.nth(4)).toHaveAttribute(
      "data-combobox-selected",
      "true",
    );
    await expect(slashItems.nth(4)).toHaveText(["Other Headings"]);
    await pressEnter(page);
    await expect(subMenu).toBeVisible();

    await type(page, "h");
    await expect(subMenu).toBeHidden();
  });

  test("should allow only pressing modifier key", async ({ page }) => {
    await initEmptyParagraphState(page);
    await focusRichText(page);

    const slashMenu = page.getByTestId("slash-menu");

    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    await page.keyboard.press(SHORT_KEY);
    await expect(slashMenu).toBeVisible();

    await page.keyboard.press("Shift");
    await expect(slashMenu).toBeVisible();
  });

  test("should allow other hotkey to passthrough", async ({ page }) => {
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await type(page, "hello");
    await pressEnter(page);
    await type(page, "world");

    const slashMenu = page.getByTestId("slash-menu");

    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    await page.keyboard.press(`${SHORT_KEY}+a`);
    await expect(slashMenu).toBeHidden();
    await assertRichTexts(page, ["hello", "world/"]);

    const selected = await getInlineSelectionText(page);
    expect(selected).toBe("world/");
  });

  test("can input search input after click menu", async ({ page }) => {
    await initEmptyParagraphState(page);
    const slashMenu = page.getByTestId("slash-menu");
    await focusRichText(page);
    await type(page, "/");
    await expect(slashMenu).toBeVisible();

    const box = await slashMenu.boundingBox();
    if (!box) {
      throw new Error("slashMenu doesn't exist");
    }
    const { x, y } = box;
    await page.mouse.click(x + 10, y + 10);
    await expect(slashMenu).toBeVisible();
    await type(page, "a");
    await assertRichTexts(page, ["/a"]);
  });
});

test.describe("slash menu should not be shown in ignored blocks", () => {
  test("code block", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await type(page, "```");
    await pressEnter(page);
    await type(page, "/");
    await expect(page.getByTestId("slash-menu")).toBeHidden();
  });
});

test("should slash menu works with fast type", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "a/text", 0);
  const slashMenu = page.getByTestId("slash-menu");
  await expect(slashMenu).toBeVisible();
});

test("should clean slash string after soft enter", async ({
  page,
}, testInfo) => {
  test.info().annotations.push({
    type: "issue",
    description: "https://github.com/example/virgultum/issues/1126",
  });
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "hello");
  await pressShiftEnter(page);
  await waitNextFrame(page);
  await type(page, "/copy");
  await pressEnter(page);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );
});

// Selection is not yet available in edgeless
test("slash menu should work in edgeless mode", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);

  await switchEditorMode(page);

  await addNote(page, "/", 30, 40);
  await assertRichTexts(page, ["", "/"]);

  const slashMenu = page.getByTestId("slash-menu");
  await expect(slashMenu).toBeVisible();
});

test.describe("slash menu with date & time", () => {
  test("should insert Today's time string", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await type(page, "/");
    const slashMenu = page.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();

    const todayBlock = page.getByTestId("slash-menu-item-action-today");
    await todayBlock.click();
    await expect(slashMenu).toBeHidden();

    const date = new Date();
    const formattedDate = formatWithTimezone(date);
    await assertRichTexts(page, [formattedDate]);
  });

  test("should create Tomorrow's time string", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await type(page, "/");
    const slashMenu = page.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();

    const todayBlock = page.getByTestId("slash-menu-item-action-tomorrow");
    await todayBlock.click();
    await expect(slashMenu).toBeHidden();

    const date = new Date();
    date.setDate(date.getDate() + 1);
    const formattedDate = formatWithTimezone(date);

    await assertRichTexts(page, [formattedDate]);
  });

  test("should insert Yesterday's time string", async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await type(page, "/");
    const slashMenu = page.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();

    const todayBlock = page.getByTestId("slash-menu-item-action-yesterday");
    await todayBlock.click();
    await expect(slashMenu).toBeHidden();

    const date = new Date();
    date.setDate(date.getDate() - 1);
    const formattedDate = formatWithTimezone(date);

    await assertRichTexts(page, [formattedDate]);
  });
});

test.describe("slash menu with style", () => {
  test("should style text line works", async ({ page }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await type(page, "hello/");
    const slashMenu = page.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();
    const bold = page.getByTestId("slash-menu-item-inline-format-bold");
    await bold.click();

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
  });

  test("should style empty line works", async ({ page }, testInfo) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    await type(page, "/");
    const slashMenu = page.getByTestId("slash-menu");
    await expect(slashMenu).toBeVisible();
    const bold = page.getByTestId("slash-menu-item-inline-format-bold");
    await bold.click();
    await page.waitForTimeout(50);
    await type(page, "hello");

    expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
      `${testInfo.title}.json`,
    );
  });
});

test("move block up and down by slash menu", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  const slashMenu = page.getByTestId("slash-menu");

  await focusRichText(page);
  await type(page, "hello");
  await pressEnter(page);
  await type(page, "world");
  await assertRichTexts(page, ["hello", "world"]);
  await type(page, "/");
  await expect(slashMenu).toBeVisible();

  const moveUp = page.getByTestId("slash-menu-item-action-move-up");
  await moveUp.click();
  await assertRichTexts(page, ["world", "hello"]);
  await type(page, "/");
  await expect(slashMenu).toBeVisible();

  const moveDown = page.getByTestId("slash-menu-item-action-move-down");
  await moveDown.click();
  await assertRichTexts(page, ["hello", "world"]);
});

test("delete block by slash menu should remove children", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await insertThreeLevelLists(page);
  const slashMenu = page.getByTestId("slash-menu");
  const slashItems = slashMenu.getByRole("option");

  await captureHistory(page);
  await focusRichText(page, 1);
  await waitNextFrame(page);
  await type(page, "/");

  await expect(slashMenu).toBeVisible();
  await type(page, "remove");
  await expect(slashItems).toHaveCount(1);
  await pressEnter(page);
  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}.json`,
  );

  await undoByKeyboard(page);
  await assertRichTexts(page, ["123", "456", "789"]);
  await redoByKeyboard(page);
  await assertRichTexts(page, ["123"]);
});

test("should slash menu can trigger linked doc popover", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "/linked");
  await pressEnter(page);
  await expect(page.locator(".linked-doc-popover")).toBeVisible();
  await assertRichTexts(page, ["@"]);

  await type(page, "doc");
  await pressEnter(page);
  await expect(page.locator("myoxus-reference")).toBeVisible();
  await expect(
    page.locator("myoxus-reference .myoxus-reference-title"),
  ).toHaveText("doc");
});
