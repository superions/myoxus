import { expect } from "@playwright/test";

import {
  enterPlaygroundRoom,
  focusRichText,
  getTextOperationSnapshot,
  initEmptyParagraphState,
  type,
} from "../utils/actions/index.js";
import { test } from "../utils/playwright.js";

test("add latex block using slash menu", async ({ page }, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await type(page, "/eq\naaa");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );

  await page
    .locator("latex-source-editor [contenteditable=true]")
    .press("Enter");
  await page.locator("myoxus-latex").dblclick();
  const source = page.locator("latex-source-editor [contenteditable=true]");
  await source.press("ControlOrMeta+A");
  await source.pressSequentially("E=mc^2");
  await source.press("Enter");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("myoxus-latex annotation")).toHaveText("aaa");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator("myoxus-latex annotation")).toHaveText("E=mc^2");
});

test("add latex block using markdown shortcut with space", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await type(page, "$$$$ aaa");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );
});

test("add latex block using markdown shortcut with enter", async ({
  page,
}, testInfo) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_init.json`,
  );

  await type(page, "$$$$\naaa");

  expect(await getTextOperationSnapshot(page)).toMatchSnapshot(
    `${testInfo.title}_finial.json`,
  );
});
