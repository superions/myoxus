import { expect, type Page } from "@playwright/test";

import { clickView } from "../../utils/actions/click.js";
import {
  addNote,
  autoFit,
  createFrame as _createFrame,
  createShapeElement,
  dragBetweenViewCoords,
  edgelessCommonSetup,
  getFirstContainerId,
  getEdgelessElementBound,
  getIds,
  getSelectedIds,
  pickColorAtPoints,
  selectFrameByTitle,
  setEdgelessTool,
  Shape,
  shiftClickView,
  toViewCoord,
  triggerComponentToolbarAction,
  zoomResetByKeyboard,
} from "../../utils/actions/edgeless.js";
import {
  pressBackspace,
  pressEscape,
  redoByKeyboard,
  SHORT_KEY,
  undoByKeyboard,
} from "../../utils/actions/keyboard.js";
import { waitNextFrame } from "../../utils/actions/misc.js";
import {
  assertCanvasElementsCount,
  assertContainerChildCount,
  assertEdgelessElementBound,
  assertSelectedBound,
} from "../../utils/asserts.js";
import { test } from "../../utils/playwright.js";

const createFrame = async (
  page: Page,
  coord1: [number, number],
  coord2: [number, number],
) => {
  const frameId = await _createFrame(page, coord1, coord2);
  await autoFit(page);
  await pressEscape(page);
  return frameId;
};

test.beforeEach(async ({ page }) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);
});

test.describe("add a frame", () => {
  const createThreeShapesAndSelectTowShape = async (page: Page) => {
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createShapeElement(page, [100, 0], [200, 100], Shape.Square);
    await createShapeElement(page, [200, 0], [300, 100], Shape.Square);

    await clickView(page, [50, 50]);
    await shiftClickView(page, [150, 50]);
  };

  test("multi select and add frame by shortcut F", async ({ page }) => {
    await createThreeShapesAndSelectTowShape(page);
    await page.keyboard.press("f");

    await expect(page.locator("myoxus-frame")).toHaveCount(1);
    await assertSelectedBound(page, [-40, -40, 280, 180]);

    const frameId = await getFirstContainerId(page);
    await assertContainerChildCount(page, frameId, 2);
  });

  test("multi select and add frame by component toolbar", async ({ page }) => {
    await createThreeShapesAndSelectTowShape(page);
    await triggerComponentToolbarAction(page, "addFrame");

    await expect(page.locator("myoxus-frame")).toHaveCount(1);
    await assertSelectedBound(page, [-40, -40, 280, 180]);

    const frameId = await getFirstContainerId(page);
    await assertContainerChildCount(page, frameId, 2);
  });

  test("multi select and add frame by more option create frame", async ({
    page,
  }) => {
    await createThreeShapesAndSelectTowShape(page);
    await triggerComponentToolbarAction(page, "createFrameOnMoreOption");

    await expect(page.locator("myoxus-frame")).toHaveCount(1);
    await assertSelectedBound(page, [-40, -40, 280, 180]);

    const frameId = await getFirstContainerId(page);
    await assertContainerChildCount(page, frameId, 2);
  });

  test("multi select add frame by edgeless toolbar", async ({ page }) => {
    await createThreeShapesAndSelectTowShape(page);
    await autoFit(page);
    await setEdgelessTool(page, "frame");
    const frameMenu = page.locator("edgeless-frame-menu");
    await expect(frameMenu).toBeVisible();
    const button = page.locator('.frame-add-button[data-name="1:1"]');
    await button.click();
    await assertSelectedBound(page, [-450, -550, 1200, 1200]);

    // the third should be inner frame because
    const frameId = await getFirstContainerId(page);
    await assertContainerChildCount(page, frameId, 3);
  });

  test("add frame by dragging with shortcut F", async ({ page }) => {
    await createThreeShapesAndSelectTowShape(page);
    await pressEscape(page); // unselect
    await autoFit(page);

    await page.keyboard.press("f");
    await dragBetweenViewCoords(page, [-10, -10], [210, 110]);

    await expect(page.locator("myoxus-frame")).toHaveCount(1);
    await assertSelectedBound(page, [-10, -10, 220, 120]);

    const frameId = await getFirstContainerId(page);
    await assertContainerChildCount(page, frameId, 2);
  });
});

test.describe("add element to frame and then move frame", () => {
  test.describe("add single element", () => {
    test("element should be moved since it is created in frame", async ({
      page,
    }) => {
      const frameId = await createFrame(page, [50, 50], [550, 550]);
      const shapeId = await createShapeElement(
        page,
        [100, 100],
        [200, 200],
        Shape.Square,
      );

      const noteCoord = await toViewCoord(page, [200, 200]);
      const noteId = await addNote(page, "", noteCoord[0], noteCoord[1]);

      await pressEscape(page);

      await selectFrameByTitle(page, frameId);
      await waitNextFrame(page);
      const noteBefore = await getEdgelessElementBound(page, noteId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeId, [150, 150, 100, 100]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
      await assertEdgelessElementBound(page, noteId, [
        noteBefore[0] + 50,
        noteBefore[1] + 50,
        noteBefore[2],
        noteBefore[3],
      ]);
    });

    test("element should be not moved since it is created not in frame", async ({
      page,
    }) => {
      const frameId = await createFrame(page, [50, 50], [550, 550]);
      const shapeId = await createShapeElement(
        page,
        [600, 600],
        [500, 500],
        Shape.Square,
      );
      await pressEscape(page);

      await selectFrameByTitle(page, frameId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeId, [500, 500, 100, 100]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
    });
  });

  test.describe("add group", () => {
    // Group
    // |<150px>|
    // ┌────┐    ─
    // │  ┌─┼──┐ 150 px
    // └──┼─┘  │ |
    //    └────┘ ─

    test("group should be moved since it is fully contained in frame", async ({
      page,
    }) => {
      const [frameId, ...shapeIds] = [
        await createFrame(page, [50, 50], [550, 550]),
        await createShapeElement(page, [100, 100], [200, 200], Shape.Square),
        await createShapeElement(page, [150, 150], [250, 250], Shape.Square),
      ];
      await pressEscape(page);

      await autoFit(page);
      await setEdgelessTool(page, "default");
      await dragBetweenViewCoords(page, [90, 90], [260, 260]);
      await expect
        .poll(async () => (await getSelectedIds(page)).sort())
        .toEqual([...shapeIds].sort());
      await page.keyboard.press(`${SHORT_KEY}+g`);
      const groupId = (await getSelectedIds(page))[0];
      await pressEscape(page);

      await selectFrameByTitle(page, frameId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeIds[0], [150, 150, 100, 100]);
      await assertEdgelessElementBound(page, shapeIds[1], [200, 200, 100, 100]);
      await assertEdgelessElementBound(page, groupId, [150, 150, 150, 150]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
    });

    test("group should be moved since its center is in frame", async ({
      page,
    }) => {
      const [frameId, ...shapeIds] = [
        await createFrame(page, [50, 50], [550, 550]),
        await createShapeElement(page, [450, 450], [550, 550], Shape.Square),
        await createShapeElement(page, [500, 500], [600, 600], Shape.Square),
      ];
      await pressEscape(page);

      await autoFit(page);
      await setEdgelessTool(page, "default");
      await dragBetweenViewCoords(page, [440, 440], [610, 610]);
      await expect
        .poll(async () => (await getSelectedIds(page)).sort())
        .toEqual([...shapeIds].sort());
      await page.keyboard.press(`${SHORT_KEY}+g`);
      const groupId = (await getSelectedIds(page))[0];
      await pressEscape(page);

      await selectFrameByTitle(page, frameId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeIds[0], [500, 500, 100, 100]);
      await assertEdgelessElementBound(page, shapeIds[1], [550, 550, 100, 100]);
      await assertEdgelessElementBound(page, groupId, [500, 500, 150, 150]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
    });
  });

  test.describe("add inner frame", () => {
    test("the inner frame and its children should be moved since it is fully contained in frame", async ({
      page,
    }) => {
      const [frameId, innerId, shapeId] = [
        await createFrame(page, [50, 50], [550, 550]),
        await createFrame(page, [100, 100], [300, 300]),
        await createShapeElement(page, [150, 150], [250, 250], Shape.Square),
      ];
      await pressEscape(page);

      await selectFrameByTitle(page, frameId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeId, [200, 200, 100, 100]);
      await assertEdgelessElementBound(page, innerId, [150, 150, 200, 200]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
    });

    test("the inner frame and its children should  be moved since its center is in frame", async ({
      page,
    }) => {
      const [frameId, innerId, shapeId] = [
        await createFrame(page, [50, 50], [550, 550]),
        await createFrame(page, [400, 400], [600, 600]),
        await createShapeElement(page, [550, 550], [600, 600], Shape.Square),
      ];
      await pressEscape(page);

      await selectFrameByTitle(page, frameId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeId, [600, 600, 50, 50]);
      await assertEdgelessElementBound(page, innerId, [450, 450, 200, 200]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
    });

    test("the inner frame and its children should also be moved even though its center is not in frame", async ({
      page,
    }) => {
      const [frameId, innerId, shapeId] = [
        await createFrame(page, [50, 50], [550, 550]),
        await createFrame(page, [500, 500], [600, 600]),
        await createShapeElement(page, [550, 550], [600, 600], Shape.Square),
      ];

      await selectFrameByTitle(page, frameId);
      await dragBetweenViewCoords(page, [60, 60], [110, 110]);

      await assertEdgelessElementBound(page, shapeId, [600, 600, 50, 50]);
      await assertEdgelessElementBound(page, innerId, [550, 550, 100, 100]);
      await assertEdgelessElementBound(page, frameId, [100, 100, 500, 500]);
    });
  });
});

test.describe("resize frame then move ", () => {
  test("resize frame to warp shape", async ({ page }) => {
    const [frameId, shapeId] = [
      await createFrame(page, [50, 50], [150, 150]),
      await createShapeElement(page, [200, 200], [300, 300], Shape.Square),
    ];
    await pressEscape(page);

    await selectFrameByTitle(page, frameId);
    await dragBetweenViewCoords(page, [150, 150], [450, 450]);

    await dragBetweenViewCoords(page, [60, 60], [110, 110]);

    await assertEdgelessElementBound(page, shapeId, [250, 250, 100, 100]);
    await assertEdgelessElementBound(page, frameId, [100, 100, 400, 400]);
  });

  test("resize frame to unwrap shape", async ({ page }) => {
    const [frameId, shapeId] = [
      await createFrame(page, [50, 50], [450, 450]),
      await createShapeElement(page, [200, 200], [300, 300], Shape.Square),
    ];
    await pressEscape(page);

    await selectFrameByTitle(page, frameId);
    await dragBetweenViewCoords(page, [450, 450], [150, 150]);

    await dragBetweenViewCoords(page, [60, 60], [110, 110]);

    await assertEdgelessElementBound(page, shapeId, [200, 200, 100, 100]);
    await assertEdgelessElementBound(page, frameId, [100, 100, 100, 100]);
  });
});

test("delete frame should also delete its children", async ({ page }) => {
  const frameId = await createFrame(page, [50, 50], [450, 450]);
  await createShapeElement(page, [200, 200], [300, 300], Shape.Square);
  await pressEscape(page);

  await selectFrameByTitle(page, frameId);
  await pressBackspace(page);
  await expect(page.locator("myoxus-frame")).toHaveCount(0);

  await assertCanvasElementsCount(page, 0);
});

test("delete frame by click ungroup should not delete its children", async ({
  page,
}) => {
  const frameId = await createFrame(page, [50, 50], [450, 450]);
  const shapeId = await createShapeElement(
    page,
    [200, 200],
    [300, 300],
    Shape.Square,
  );
  await pressEscape(page);

  await selectFrameByTitle(page, frameId);
  const toolbar = page.getByTestId("selection-toolbar");
  const ungroupButton = toolbar.getByLabel("Ungroup");
  await ungroupButton.click();

  await assertCanvasElementsCount(page, 1);
  expect(await getIds(page)).toEqual([shapeId]);
});

test("outline should keep updated during a new frame created by frame-tool dragging", async ({
  page,
}) => {
  await page.keyboard.press("f");

  const start = await toViewCoord(page, [0, 0]);
  const end = await toViewCoord(page, [100, 100]);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 10 });
  await page.waitForTimeout(50);

  expect(
    await pickColorAtPoints(page, [start, [end[0] - 1, end[1] - 1]]),
  ).toEqual(["#1e96eb", "#1e96eb"]);
});

test("undo/redo should work when change frame background", async ({ page }) => {
  const frameId = await createFrame(page, [50, 50], [450, 450]);
  await pressEscape(page);

  await selectFrameByTitle(page, frameId);

  const getFrameBackground = async () => {
    return page
      .locator("myoxus-frame .myoxus-frame-container")
      .evaluate((el) => {
        return getComputedStyle(el).backgroundColor;
      });
  };
  const colorPanel = page.locator("edgeless-color-picker-button");

  let prevBackground = await getFrameBackground();

  // preset color
  {
    await colorPanel.getByLabel("Background", { exact: true }).click();
    await colorPanel.getByLabel("LightRed").click();
    expect(await getFrameBackground()).not.toBe(prevBackground);
    await colorPanel.getByLabel("Background", { exact: true }).click();

    await undoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getFrameBackground()).toBe(prevBackground);

    await redoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getFrameBackground()).not.toBe(prevBackground);
  }

  prevBackground = await getFrameBackground();

  // custom color
  {
    await selectFrameByTitle(page, frameId);
    await colorPanel.getByLabel("Background", { exact: true }).click();
    await expect(colorPanel.locator("editor-menu-button")).toHaveAttribute(
      "data-open",
      "true",
    );
    await colorPanel.locator("edgeless-color-custom-button").click();
    await page.locator(".color-palette").click({
      position: {
        x: 100,
        y: 100,
      },
    });
    await pressEscape(page);

    expect(await getFrameBackground()).not.toBe(prevBackground);
    await undoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getFrameBackground()).toBe(prevBackground);

    await redoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getFrameBackground()).not.toBe(prevBackground);
  }
});

test("connector and shape created simultaneously with edgeless-auto-complete should both be added to frame", async ({
  page,
}) => {
  // Create a larger frame to ensure everything fits
  const frameId = await createFrame(page, [50, 50], [650, 650]);

  // Create first shape inside the frame (well within bounds)
  const shape1Id = await createShapeElement(
    page,
    [150, 150],
    [250, 250],
    Shape.Square,
  );

  // Click on the existing shape to start connection
  await clickView(page, [200, 200]);

  const autoComplete = page.locator("edgeless-auto-complete");
  const rightArrowButton = autoComplete
    .locator(".edgeless-auto-complete-arrow")
    .nth(0);

  await rightArrowButton.click();

  // Wait for async processing
  await waitNextFrame(page);

  // Verify that the frame contains 3 children: original shape + new shape + connector
  await assertContainerChildCount(page, frameId, 3);

  // Verify by moving the frame - all elements should move together

  await selectFrameByTitle(page, frameId);
  await dragBetweenViewCoords(page, [60, 60], [110, 110]);

  // Check that the original shape moved with the frame
  await assertEdgelessElementBound(page, shape1Id, [200, 200, 100, 100]);
  await assertEdgelessElementBound(page, frameId, [100, 100, 600, 600]);

  // Frame should still contain all 3 elements after the move
  await assertContainerChildCount(page, frameId, 3);
});
