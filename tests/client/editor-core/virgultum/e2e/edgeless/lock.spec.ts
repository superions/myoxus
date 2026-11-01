import { expect, type Page } from "@playwright/test";

import { clickView, dblclickView, moveView } from "../utils/actions/click.js";
import {
  createConnectorElement,
  createFrame,
  createMindmap,
  createShapeElement,
  deleteAll,
  dragBetweenViewCoords,
  edgelessCommonSetup,
  getContainerChildIds,
  getSelectedBound,
  getSelectedIds,
  getTypeById,
  selectElementInEdgeless,
  selectFrameByTitle,
  setEdgelessTool,
} from "../utils/actions/edgeless.js";
import {
  copyByKeyboard,
  pasteByKeyboard,
  pressArrowDown,
  pressBackspace,
  pressEscape,
  pressForwardDelete,
  selectAllByKeyboard,
  SHORT_KEY,
  undoByKeyboard,
} from "../utils/actions/keyboard.js";

import {
  assertCanvasElementsCount,
  assertEdgelessElementBound,
  assertEdgelessSelectedModelRect,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";

test.describe("lock", () => {
  const getButtons = (page: Page) => {
    const toolbar = page.getByTestId("selection-toolbar");
    return {
      lock: toolbar.getByTestId("lock"),
      unlock: toolbar.getByTestId("unlock"),
    };
  };

  test("locked element should be selectable by clicking or short-cut", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    await createShapeElement(page, [100, 100], [150, 150]);
    await selectAllByKeyboard(page);

    await getButtons(page).lock.click();
    expect(await getSelectedIds(page)).toHaveLength(1);
    await pressEscape(page);
    expect(await getSelectedIds(page)).toHaveLength(0);
    await selectAllByKeyboard(page);
    expect(await getSelectedIds(page)).toHaveLength(1);

    await pressEscape(page);
    await clickView(page, [125, 125]);
    expect(await getSelectedIds(page)).toHaveLength(1);
  });

  test("locked element should not be selectable by dragging default tool. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    await createShapeElement(page, [100, 100], [150, 150]);
    await selectAllByKeyboard(page);

    const { lock, unlock } = getButtons(page);

    await lock.click();
    await pressEscape(page);
    await dragBetweenViewCoords(page, [90, 90], [160, 160]);
    expect(await getSelectedIds(page)).toHaveLength(0);

    await clickView(page, [125, 125]);
    await unlock.click();
    await dragBetweenViewCoords(page, [90, 90], [160, 160]);
    expect(await getSelectedIds(page)).toHaveLength(1);
  });

  test("descendant of locked element should not be selectable. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const shapeId = await createShapeElement(page, [100, 100], [150, 150]);
    await createShapeElement(page, [150, 150], [200, 200]);
    await selectAllByKeyboard(page);
    await page.keyboard.press(`${SHORT_KEY}+g`);
    const groupId = (await getSelectedIds(page))[0];

    const { lock, unlock } = getButtons(page);

    await lock.click();
    await pressEscape(page);
    await clickView(page, [125, 125]);
    expect(await getSelectedIds(page)).toEqual([groupId]);
    await clickView(page, [125, 125]);
    expect(await getSelectedIds(page)).toEqual([groupId]);

    await unlock.click();
    await clickView(page, [125, 125]);
    expect(await getSelectedIds(page)).toEqual([shapeId]);
    await pressEscape(page);

    const frameId = await createFrame(page, [50, 50], [250, 250]);
    await selectAllByKeyboard(page);
    await lock.click();
    await pressEscape(page);
    await clickView(page, [125, 125]);
    expect(await getSelectedIds(page)).toEqual([frameId]);
    await unlock.click();
    await clickView(page, [125, 125]);
    expect(await getSelectedIds(page)).toEqual([shapeId]);
  });

  test("the selected rect of locked element should contain descendant. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    // frame
    await createFrame(page, [0, 0], [100, 100]);
    const shapeId = await createShapeElement(page, [100, 100], [150, 150]);
    await dragBetweenViewCoords(page, [125, 125], [95, 95]); // add shape to frame, and partial area out of frame
    await selectAllByKeyboard(page);

    await assertEdgelessSelectedModelRect(page, [0, 0, 100, 100]); // only frame outline

    const { lock, unlock } = getButtons(page);

    await lock.click();
    await assertEdgelessSelectedModelRect(page, [0, 0, 125, 125]); // frame outline and shape
    await pressEscape(page);
    await clickView(page, [90, 90]);
    await assertEdgelessSelectedModelRect(page, [0, 0, 125, 125]);

    await unlock.click();
    await assertEdgelessSelectedModelRect(page, [0, 0, 100, 100]);
    await pressEscape(page);
    await selectElementInEdgeless(page, [shapeId]);
    await assertEdgelessSelectedModelRect(page, [75, 75, 50, 50]);

    await deleteAll(page);

    // mindmap
    await createMindmap(page, [100, 100]);
    const bound = await getSelectedBound(page);
    const rootNodePos: [number, number] = [
      bound[0] + 10,
      bound[1] + 0.5 * bound[3],
    ];

    await clickView(page, rootNodePos);
    const rootNodeBound = await getSelectedBound(page);

    await lock.click();
    await assertEdgelessSelectedModelRect(page, bound);
    await clickView(page, rootNodePos);
    await assertEdgelessSelectedModelRect(page, bound);

    await unlock.click();
    await assertEdgelessSelectedModelRect(page, bound);
    await clickView(page, rootNodePos);
    await assertEdgelessSelectedModelRect(page, rootNodeBound);
  });

  test("locked element should be copyable, and the copy is unlocked", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    await createShapeElement(page, [100, 100], [150, 150]);
    await selectAllByKeyboard(page);

    await getButtons(page).lock.click();
    await pressEscape(page);
    await clickView(page, [125, 125]);
    await copyByKeyboard(page);
    await moveView(page, [200, 200]);
    await pasteByKeyboard(page);
    await clickView(page, [200, 200]);
    await expect(getButtons(page).lock).toBeVisible();
  });

  test("locked element and descendant should not be draggable and moved by arrow key. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const frame = await createFrame(page, [50, 50], [250, 250]);
    const shape1 = await createShapeElement(page, [100, 100], [150, 150]);
    const shape2 = await createShapeElement(page, [150, 150], [200, 200]);
    await selectAllByKeyboard(page);

    await getButtons(page).lock.click();
    await pressEscape(page);

    await dragBetweenViewCoords(page, [100, 100], [150, 150]);
    await assertEdgelessElementBound(page, frame, [50, 50, 200, 200]);
    await assertEdgelessElementBound(page, shape1, [100, 100, 50, 50]);
    await assertEdgelessElementBound(page, shape2, [150, 150, 50, 50]);

    await pressArrowDown(page, 3);
    await assertEdgelessElementBound(page, frame, [50, 50, 200, 200]);
    await assertEdgelessElementBound(page, shape1, [100, 100, 50, 50]);
    await assertEdgelessElementBound(page, shape2, [150, 150, 50, 50]);

    await getButtons(page).unlock.click();
    await dragBetweenViewCoords(page, [100, 100], [150, 150]);
    await assertEdgelessElementBound(page, frame, [100, 100, 200, 200]);
    await assertEdgelessElementBound(page, shape1, [150, 150, 50, 50]);
    await assertEdgelessElementBound(page, shape2, [200, 200, 50, 50]);

    await pressArrowDown(page, 3);
    await assertEdgelessElementBound(page, frame, [100, 103, 200, 200]);
    await assertEdgelessElementBound(page, shape1, [150, 153, 50, 50]);
    await assertEdgelessElementBound(page, shape2, [200, 203, 50, 50]);
  });

  test("locked element should be moved if parent is moved", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const frame = await createFrame(page, [50, 50], [250, 250]);
    const shape = await createShapeElement(page, [100, 100], [150, 150]);
    await clickView(page, [125, 125]);
    await getButtons(page).lock.click();

    await selectAllByKeyboard(page);
    await dragBetweenViewCoords(page, [100, 100], [150, 150]);

    await assertEdgelessElementBound(page, frame, [100, 100, 200, 200]);
    await assertEdgelessElementBound(page, shape, [150, 150, 50, 50]);
  });

  test("locked element should not be scalable and rotatable. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    await createShapeElement(page, [100, 100], [150, 150]);
    await selectAllByKeyboard(page);

    const rect = page.locator("edgeless-selected-rect");
    const { lock, unlock } = getButtons(page);
    await expect(rect.locator(".resize")).toHaveCount(8);
    await expect(rect.locator(".rotate")).toHaveCount(4);

    await lock.click();
    await expect(rect.locator(".resize")).toHaveCount(0);
    await expect(rect.locator(".rotate")).toHaveCount(0);

    await unlock.click();
    await expect(rect.locator(".resize")).toHaveCount(8);
    await expect(rect.locator(".rotate")).toHaveCount(4);
  });

  test("locked shape should not be editable and unlock restores ownership", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const shapeId = await createShapeElement(page, [100, 100], [150, 150]);
    const { lock, unlock } = getButtons(page);
    const isLocked = () =>
      page.evaluate((id) => {
        const root = document.querySelector("myoxus-edgeless-root");
        return root?.gfx.getElementById(id)?.lockedBySelf ?? false;
      }, shapeId);

    await lock.click();
    await expect.poll(isLocked).toBe(true);
    await dblclickView(page, [125, 125]);
    await expect(page.locator("edgeless-shape-text-editor")).toHaveCount(0);

    await unlock.click();
    await expect.poll(isLocked).toBe(false);
  });

  test("locked element should not be deletable. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    await createShapeElement(page, [100, 100], [150, 150]);
    await selectAllByKeyboard(page);
    const { lock, unlock } = getButtons(page);

    await lock.click();
    await clickView(page, [125, 125]);
    await pressBackspace(page);
    await assertCanvasElementsCount(page, 1);
    await page.keyboard.press("Delete");
    await assertCanvasElementsCount(page, 1);
    await pressForwardDelete(page);
    await assertCanvasElementsCount(page, 1);
    await setEdgelessTool(page, "eraser");
    await dragBetweenViewCoords(page, [90, 90], [160, 160], { steps: 2 });
    await assertCanvasElementsCount(page, 1);
    await setEdgelessTool(page, "default");

    await selectAllByKeyboard(page);
    await unlock.click();
    await page.evaluate(() => {
      window.doc.captureSync();
    });
    await pressBackspace(page);
    await assertCanvasElementsCount(page, 0);
    await undoByKeyboard(page);
    await assertCanvasElementsCount(page, 1);
    await page.keyboard.press("Delete");
    await assertCanvasElementsCount(page, 0);
    await undoByKeyboard(page);
    await assertCanvasElementsCount(page, 1);
    await pressForwardDelete(page);
    await assertCanvasElementsCount(page, 0);
    await undoByKeyboard(page);
    await assertCanvasElementsCount(page, 1);
    await setEdgelessTool(page, "eraser");
    await dragBetweenViewCoords(page, [90, 90], [160, 160], { steps: 2 });
    await assertCanvasElementsCount(page, 0);
  });

  test("locked frame should not add new child element. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const frame = await createFrame(page, [50, 50], [250, 250]);
    await selectAllByKeyboard(page);
    const { lock, unlock } = getButtons(page);

    await lock.click();
    const shape = await createShapeElement(page, [100, 100], [150, 150]);

    expect(await getContainerChildIds(page, frame)).toHaveLength(0);

    await selectFrameByTitle(page, frame);
    await unlock.click();
    expect(await getContainerChildIds(page, frame)).toHaveLength(0);
    await clickView(page, [125, 125]);
    await dragBetweenViewCoords(page, [125, 125], [130, 130]); // move shape into frame
    expect(await getContainerChildIds(page, frame)).toEqual([shape]);
  });

  test("endpoint of locked connector should not be changeable. unlocking will recover", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    await createConnectorElement(page, [100, 100], [150, 150]);
    const handles = page.locator("edgeless-connector-handle");
    await expect(handles).toHaveCount(1);
    const { lock, unlock } = getButtons(page);
    await lock.click();
    await expect(handles).toHaveCount(0);
    await unlock.click();
    await expect(handles).toHaveCount(1);
  });

  test("locking multiple elements will create locked group. unlocking a group will release elements", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const shape1 = await createShapeElement(page, [100, 100], [150, 150]);
    const shape2 = await createShapeElement(page, [150, 150], [200, 200]);
    await selectAllByKeyboard(page);
    const { lock, unlock } = getButtons(page);
    await lock.click();
    const group = (await getSelectedIds(page))[0];
    expect(group).not.toBeUndefined();
    expect(await getTypeById(page, group)).toBe("group");

    await unlock.click();
    expect(await getSelectedIds(page)).toEqual([shape1, shape2]);
  });

  test("unlocking an element should not unlock its locked descendant", async ({
    page,
  }) => {
    await edgelessCommonSetup(page);
    const frame = await createFrame(page, [50, 50], [250, 250]);
    await createShapeElement(page, [150, 150], [200, 200]);

    const { lock, unlock } = getButtons(page);

    await clickView(page, [175, 175]);
    await lock.click();
    await selectFrameByTitle(page, frame);
    await lock.click();
    await unlock.click();
    await clickView(page, [175, 175]);
    await expect(lock).toBeHidden();
    await expect(unlock).toBeVisible();
  });
});
