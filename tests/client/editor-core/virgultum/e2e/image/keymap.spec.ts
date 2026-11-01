import {
  activeEmbed,
  enterPlaygroundRoom,
  initImageState,
  pressEnter,
  type,
} from "../utils/actions/index.js";
import { assertRichImage, assertRichTexts } from "../utils/asserts.js";
import { test } from "../utils/playwright.js";

test.beforeEach(async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initImageState(page, true);
  await assertRichImage(page, 1);
});

test("press enter will create new block when click and select image", async ({
  page,
}) => {
  await activeEmbed(page);
  await pressEnter(page);
  await type(page, "aa");
  await assertRichTexts(page, ["", "aa"]);
});
