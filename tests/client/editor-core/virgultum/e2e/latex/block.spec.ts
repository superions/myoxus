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
