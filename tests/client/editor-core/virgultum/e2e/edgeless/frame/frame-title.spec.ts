import { expect, type Page } from "@playwright/test";

import {
  autoFit,
  createFrame as _createFrame,
  dragBetweenViewCoords,
  edgelessCommonSetup,
  getFrameTitle,
  getSelectedBound,
  toModelCoord,
  zoomOutByKeyboard,
  zoomResetByKeyboard,
} from "../../utils/actions/edgeless.js";
import {
  pressBackspace,
  pressEnter,
  type,
} from "../../utils/actions/keyboard.js";

import { assertRectExist } from "../../utils/asserts.js";
import { test } from "../../utils/playwright.js";

const createFrame = async (
  page: Page,
  coord1: [number, number],
  coord2: [number, number],
) => {
  const frame = await _createFrame(page, coord1, coord2);
  await autoFit(page);
  return frame;
};

test.beforeEach(async ({ page }) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);
});

const enterFrameTitleEditor = async (page: Page) => {
  const frameTitle = page.locator("myoxus-frame-title");
  // Native actionability also rejects a pointer-transparent title and waits
  // for viewport fitting to settle before choosing the click coordinates.
  await frameTitle.dblclick();

  const frameTitleEditor = page.locator("edgeless-frame-title-editor");
  await frameTitleEditor.waitFor({
    state: "attached",
  });
  return frameTitleEditor;
};

test.describe("frame title rendering", () => {
  test("frame title should be displayed", async ({ page }) => {
    const frame = await createFrame(page, [50, 50], [150, 150]);

    const frameTitle = getFrameTitle(page, frame);
    await expect(frameTitle).toBeVisible();
    await expect(frameTitle).toHaveText("Frame 1");
  });

  test("should not display frame title component when title is empty", async ({
    page,
  }) => {
    const frame = await createFrame(page, [50, 50], [150, 150]);
    await enterFrameTitleEditor(page);

    await pressBackspace(page);
    await pressEnter(page);
    const frameTitle = getFrameTitle(page, frame);
    await expect(frameTitle).toBeHidden();
  });
});

test.describe("frame title editing", () => {
  test("edit frame title by db-click title", async ({ page }) => {
    const frame = await createFrame(page, [50, 50], [150, 150]);
    const frameTitle = getFrameTitle(page, frame);

    await enterFrameTitleEditor(page);

    await type(page, "ABC");
    await pressEnter(page);
    await expect(frameTitle).toHaveText("ABC");
  });

  test("frame title can be edited repeatedly", async ({ page }) => {
    const frame = await createFrame(page, [50, 50], [150, 150]);
    const frameTitle = getFrameTitle(page, frame);

    await enterFrameTitleEditor(page);
    await type(page, "ABC");
    await pressEnter(page);

    await enterFrameTitleEditor(page);
    await type(page, "DEF");
    await pressEnter(page);
    await expect(frameTitle).toHaveText("DEF");
  });

  test("edit frame after zoom", async ({ page }) => {
    const frame = await createFrame(page, [50, 50], [150, 150]);
    const frameTitle = getFrameTitle(page, frame);

    await zoomOutByKeyboard(page);
    await enterFrameTitleEditor(page);
    await type(page, "ABC");
    await pressEnter(page);
    await expect(frameTitle).toHaveText("ABC");
  });

  test("edit frame title after drag", async ({ page }) => {
    const frame = await createFrame(page, [50, 50], [150, 150]);
    const frameTitle = getFrameTitle(page, frame);
    await dragBetweenViewCoords(page, [50 + 10, 50 + 10], [50 + 20, 50 + 20]);

    await enterFrameTitleEditor(page);
    await type(page, "ABC");
    await pressEnter(page);
    await expect(frameTitle).toHaveText("ABC");
  });
});

test("frame title should be draggable", async ({ page }) => {
  const frame = await createFrame(page, [50, 50], [150, 150]);
  const frameTitle = getFrameTitle(page, frame);
  const frameTitleRect = await frameTitle.boundingBox();
  assertRectExist(frameTitleRect);

  const center = await toModelCoord(page, [
    frameTitleRect.x + frameTitleRect.width / 2,
    frameTitleRect.y + frameTitleRect.height / 2,
  ]);

  await dragBetweenViewCoords(page, center, [center[0] + 10, center[1] + 10]);
  const frameRect = await getSelectedBound(page);
  expect(frameRect).toEqual([60, 60, 100, 100]);
});
