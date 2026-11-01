import { expect } from "@playwright/test";

import * as actions from "../../utils/actions/edgeless.js";
import {
  getNoteBoundBoxInEdgeless,
  setEdgelessTool,
  switchEditorMode,
} from "../../utils/actions/edgeless.js";
import {
  addBasicBrushElement,
  addBasicRectShapeElement,
  clickInCenter,
  dragBetweenCoords,
  enterPlaygroundRoom,
  getBoundingRect,
  initEmptyEdgelessState,
  initEmptySurfaceState,
  initThreeParagraphs,
  pressEnter,
  pressEscape,
  waitNextFrame,
} from "../../utils/actions/index.js";
import {
  assertBlockCount,
  assertEdgelessSelectedRect,
  assertRectExist,
  assertSelectionInNote,
} from "../../utils/asserts.js";
import { test } from "../../utils/playwright.js";

test("select multiple shapes and translate", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptySurfaceState(page);

  await switchEditorMode(page);
  await actions.zoomResetByKeyboard(page);

  await addBasicBrushElement(page, { x: 100, y: 100 }, { x: 200, y: 200 });
  await page.mouse.click(110, 110);
  await assertEdgelessSelectedRect(page, [98, 98, 104, 104]);

  await addBasicRectShapeElement(page, { x: 210, y: 110 }, { x: 310, y: 210 });
  await page.mouse.click(220, 120);
  await assertEdgelessSelectedRect(page, [210, 110, 100, 100]);

  await dragBetweenCoords(page, { x: 120, y: 90 }, { x: 220, y: 130 });
  await assertEdgelessSelectedRect(page, [98, 98, 212, 112]);

  await dragBetweenCoords(page, { x: 120, y: 120 }, { x: 150, y: 150 });
  await assertEdgelessSelectedRect(page, [128, 128, 212, 112]);

  await page.mouse.click(160, 160);
  await assertEdgelessSelectedRect(page, [128, 128, 104, 104]);

  await page.mouse.click(250, 150);
  await assertEdgelessSelectedRect(page, [240, 140, 100, 100]);
});

test("selection box of shape element sync on fast dragging", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  await actions.zoomResetByKeyboard(page);

  await setEdgelessTool(page, "shape");
  await dragBetweenCoords(page, { x: 100, y: 100 }, { x: 200, y: 200 });
  await setEdgelessTool(page, "default");
  await dragBetweenCoords(
    page,
    { x: 110, y: 110 },
    { x: 660, y: 460 },
    { click: true },
  );

  await assertEdgelessSelectedRect(page, [650, 450, 100, 100]);
});

test("when the selection is always a note, it should remain in an active state", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  const ids = await initEmptyEdgelessState(page);
  await initThreeParagraphs(page);

  await switchEditorMode(page);
  await actions.zoomResetByKeyboard(page);
  const bound = await getNoteBoundBoxInEdgeless(page, ids.noteId);

  await setEdgelessTool(page, "note");
  const newNoteX = bound.x;
  const newNoteY = bound.y + bound.height + 100;
  // add text
  await page.mouse.click(newNoteX, newNoteY);
  await waitNextFrame(page);
  await page.keyboard.type("hello");
  await pressEnter(page);
  // should wait for inline editor update and resizeObserver callback
  await waitNextFrame(page);
  // assert add text success
  await assertBlockCount(page, "edgeless-note", 2);

  await clickInCenter(page, bound);
  await clickInCenter(page, bound);
  await waitNextFrame(page);
  await assertSelectionInNote(page, ids.noteId, "myoxus-edgeless-note");
});

test("should auto panning when selection rectangle reaches viewport edges", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptySurfaceState(page);
  await switchEditorMode(page);
  await actions.zoomResetByKeyboard(page);
  await addBasicRectShapeElement(page, { x: 200, y: 100 }, { x: 300, y: 200 });
  const { width, height } = page.viewportSize()!;
  // Each direction starts from known geometry. The old sequence accumulated
  // prior pans and ended outside the viewport, then selected an incidental Note.
  const cases = [
    { center: [width / 2 + 400, height / 2], start: [400, 250], edge: [1, 50] },
    {
      center: [width / 2, height / 2 + 400],
      start: [350, 350],
      edge: [150, 1],
    },
    {
      center: [width / 2 - width, height / 2],
      start: [150, 250],
      edge: [width - 1, 50],
    },
    {
      center: [width / 2, height / 2 - height],
      start: [350, 50],
      edge: [150, height - 1],
    },
  ];
  for (const { center, start, edge } of cases) {
    await page.keyboard.press("Escape");
    await actions.setViewportCenter(page, center as [number, number]);
    await page.mouse.move(start[0], start[1]);
    await page.mouse.down();
    await page.mouse.move(edge[0], edge[1], { steps: 10 });
    // Wait for the actual auto-pan selection, not a machine-dependent 500ms.
    await expect
      .poll(() =>
        page
          .locator("myoxus-edgeless-root")
          .evaluate((root) =>
            root.gfx.selection.selectedElements.map((e) => e.type),
          ),
      )
      .toEqual(["shape"]);
    await page.mouse.up();
    await expect(page.locator(".myoxus-edgeless-selected-rect")).toBeVisible();
  }
});

test("should also update dragging area when viewport changes", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptySurfaceState(page);
  await switchEditorMode(page);
  await actions.zoomResetByKeyboard(page);
  const origin = await actions.toModelCoord(page, [200, 300]);
  await page.mouse.move(200, 300);
  await page.mouse.down();
  await page.mouse.move(600, 200, { steps: 10 });
  const before = await getBoundingRect(page, ".myoxus-edgeless-dragging-area");
  await page.mouse.wheel(0, -300);
  await expect(async () => {
    const [x, y] = await actions.toViewCoord(page, origin);
    expect(y).not.toBe(300);
    const after = await getBoundingRect(page, ".myoxus-edgeless-dragging-area");
    expect(after.x).toBeCloseTo(Math.min(x, 600), 0);
    expect(after.y).toBeCloseTo(Math.min(y, 200), 0);
    expect(after.width).toBeCloseTo(Math.abs(600 - x), 0);
    expect(after.height).toBeCloseTo(Math.abs(200 - y), 0);
    expect(after.height).not.toBe(before.height);
  }).toPass({ timeout: 5000 });
  await page.mouse.up();
});

test("should select shapes while moving selection", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptySurfaceState(page);
  await switchEditorMode(page);
  await actions.zoomResetByKeyboard(page);

  await addBasicRectShapeElement(page, { x: 100, y: 100 }, { x: 200, y: 200 });

  // Make the selection out side the rect and move the selection to the rect
  await dragBetweenCoords(
    page,
    // Make the selection not selecting the rect
    { x: 70, y: 70 },
    { x: 90, y: 90 },
    {
      beforeMouseUp: async () => {
        await page.keyboard.down("Space");
        // Move the selection over to the rect
        await page.mouse.move(120, 120);
        await page.keyboard.up("Space");
      },
    },
  );

  await assertEdgelessSelectedRect(page, [100, 100, 100, 100]);

  await addBasicBrushElement(page, { x: 210, y: 100 }, { x: 310, y: 300 });
  await page.mouse.click(211, 101);

  // Make a wide selection and move it to select both of the shapes
  await dragBetweenCoords(
    page,
    // Make the selection above the spaces
    { x: 70, y: 70 },
    { x: 400, y: 90 },
    {
      beforeMouseUp: async () => {
        await page.keyboard.down("Space");
        // Move the selection over both of the shapes
        await page.mouse.move(400, 120);
        await page.keyboard.up("Space");
      },
    },
  );

  await assertEdgelessSelectedRect(page, [100, 98, 212, 204]);
});

test("should the selected rect be below the edgeless element toolbar", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await switchEditorMode(page);

  const toolbar = page.locator(".edgeless-toolbar-container");
  const toolbarRect = await toolbar.boundingBox();
  assertRectExist(toolbarRect);

  await actions.addNote(page, "hello", toolbarRect.x, toolbarRect.y - 20);
  await pressEscape(page, 3);

  await page.mouse.click(toolbarRect.x, toolbarRect.y - 20);

  const selectedRect = page.locator(".myoxus-edgeless-selected-rect");
  await expect(selectedRect).toBeVisible();

  const brHandle = selectedRect.getByLabel("bottom-right");
  const brHandleRect = await brHandle.boundingBox();
  assertRectExist(brHandleRect);

  // make sure the position of br handle is inside the toolbar
  expect(
    brHandleRect.x > toolbarRect.x &&
      brHandleRect.x < toolbarRect.x + toolbarRect.width &&
      brHandleRect.y > toolbarRect.y &&
      brHandleRect.y < toolbarRect.y + toolbarRect.height,
  ).toBe(true);

  const brHandleCenter = [
    brHandleRect.x + brHandleRect.width / 2,
    brHandleRect.y + brHandleRect.height / 2,
  ];

  // get element from the center of br handle
  const topElement = await page.evaluate((brHandleCenter) => {
    const element = document.elementFromPoint(
      brHandleCenter[0],
      brHandleCenter[1],
    );
    if (!element) {
      throw new Error("element not found");
    }
    return element.tagName;
  }, brHandleCenter);

  expect(topElement).toBe("EDGELESS-TOOLBAR-WIDGET");
});
