import { expect, type Page } from "@playwright/test";

import {
  addBasicBrushElement,
  createConnectorElement,
  createFrameElement,
  createNote,
  createShapeElement,
  getNoteRect,
  setEdgelessTool,
  setViewportCenter,
  Shape,
  toViewCoord,
  triggerComponentToolbarAction,
} from "../utils/actions/edgeless.js";
import {
  clickView,
  edgelessCommonSetup,
  selectAllByKeyboard,
  type,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertEdgelessSelectedModelRect,
  getSelectedRect,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";

async function commonSetup(page: Page) {
  await edgelessCommonSetup(page);
  // This fixture includes negative world coordinates. Keep them visible so
  // pointer gestures reach the Canvas rather than the browser's outside area.
  await setViewportCenter(page, [200, 150]);
}

async function arrangementBounds(page: Page) {
  return page.evaluate(() =>
    document
      .querySelector("myoxus-edgeless-root")!
      .gfx.selection.selectedElements.map((model) => {
        const { x, y, w, h } = model.elementBound;
        return {
          id: model.id,
          connector: model.type === "connector",
          x,
          y,
          w,
          h,
        };
      }),
  );
}

async function assertArrangement(
  page: Page,
  before: Awaited<ReturnType<typeof arrangementBounds>>,
  resize = false,
) {
  // Assert the user-visible arrangement contract, not font-dependent golden
  // widths: four items per row, spacing, preserved aspect ratios and identities.
  await expect(async () => {
    const after = await arrangementBounds(page);
    expect(after.map((b) => b.id).sort()).toEqual(
      before.map((b) => b.id).sort(),
    );
    for (const box of after) {
      const original = before.find((b) => b.id === box.id)!;
      const scale = resize && !box.connector ? 200 / original.h : 1;
      expect(box.w).toBeCloseTo(original.w * scale, 0);
      expect(box.h).toBeCloseTo(original.h * scale, 0);
    }
    const rows: (typeof after)[] = [];
    for (const box of after.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const row = rows.find((row) => Math.abs(row[0].y - box.y) < 0.5);
      if (row) row.push(box);
      else rows.push([box]);
    }
    expect(rows).toHaveLength(Math.ceil(before.length / 4));
    for (const [index, row] of rows.entries()) {
      expect(row.length).toBeLessThanOrEqual(4);
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++)
        expect(row[i].x - row[i - 1].x - row[i - 1].w).toBeCloseTo(20, 0);
      if (index) {
        const previous = rows[index - 1];
        expect(
          row[0].y - previous[0].y - Math.max(...previous.map((b) => b.h)),
        ).toBeCloseTo(20, 0);
      }
    }
  }).toPass({ timeout: 5000 });
}

test.describe("auto arrange align", () => {
  test("arrange shapes", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);
    await createShapeElement(page, [100, -100], [300, 100], Shape.Ellipse);
    await createShapeElement(page, [200, 300], [300, 400], Shape.Square);
    await createShapeElement(page, [400, 100], [500, 200], Shape.Triangle);
    await createShapeElement(
      page,
      [0, 200],
      [100, 300],
      Shape["Rounded rectangle"],
    );

    await page.mouse.click(0, 0);
    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, -100, 500, 500]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 560, 320]);
  });

  test("arrange rotated shapes", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Ellipse);
    await createShapeElement(page, [100, 100], [200, 200], Shape.Square);

    const point = await toViewCoord(page, [100, 100]);
    await page.mouse.click(point[0] + 50, point[1] + 50);
    await page.mouse.move(point[0] - 5, point[1] - 5);
    await page.mouse.down();
    await page.mouse.move(point[0] - 5, point[1] + 45);
    await page.mouse.up();

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 220, 220]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 261, 141]);
  });

  test("arrange connected shapes", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createShapeElement(page, [100, 100], [200, 200], Shape.Ellipse);
    await createConnectorElement(page, [50, 100], [150, 100]);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 200, 200]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, -21, 220, 141.4]);
  });

  test("arrange connector", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createConnectorElement(page, [200, 200], [300, 200]);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 300, 200]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 220, 100]);
  });

  test("arrange edgeless text", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);

    const point = await toViewCoord(page, [200, -100]);
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(point[0], point[1], {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "a");
    await page.mouse.click(0, 0);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, -125, 395, 225]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 340, 100]);
  });

  test("arrange note", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    const noteId = await createNote(page, [200, 200], "Hello World");
    await page.mouse.click(0, 0);
    const note = await getNoteRect(page, noteId);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [
      0,
      0,
      note.x + note.w,
      note.y + note.h,
    ]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 618, 100]);
  });

  test("arrange group", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [200, 300], [300, 400], Shape.Square);
    await createShapeElement(page, [400, 100], [500, 200], Shape.Triangle);
    await selectAllByKeyboard(page);
    await triggerComponentToolbarAction(page, "addGroup");

    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);
    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 500, 400]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 420, 300]);
  });

  test("arrange frame", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [200, 300], [300, 400], Shape.Square);
    await createShapeElement(page, [400, 100], [500, 200], Shape.Triangle);
    await selectAllByKeyboard(page);
    await createFrameElement(page, [150, 50], [550, 450]);

    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);

    await page.mouse.click(0, 0);
    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 550, 450]);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 520, 400]);
  });

  // TODO mindmap size different on CI
  test("arrange mindmap", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);
    await page.keyboard.press("m");
    await clickView(page, [500, 200]);

    await selectAllByKeyboard(page);
    const box1 = await getSelectedRect(page);
    expect(box1.width).toBeGreaterThan(700);
    expect(box1.height).toBeGreaterThan(300);

    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    const box2 = await getSelectedRect(page);
    expect(box2.width).toBeLessThan(550);
    expect(box2.height).toBeLessThan(210);
  });

  test("arrange shape, note, connector, brush and edgeless text", async ({
    page,
  }) => {
    await commonSetup(page);
    // shape
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createShapeElement(page, [150, 150], [300, 300], Shape.Ellipse);
    //note
    await createNote(page, [200, 100], "Hello World");
    // connector
    await createConnectorElement(page, [200, -200], [400, -100]);
    // brush
    const start = { x: 400, y: 400 };
    const end = { x: 480, y: 480 };
    await addBasicBrushElement(page, start, end);
    // edgeless text
    const point = await toViewCoord(page, [-100, -100]);
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(point[0], point[1], {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "edgeless text");

    await page.mouse.click(0, 0);
    await selectAllByKeyboard(page);

    await assertEdgelessSelectedModelRect(page, [-125, -200, 793, 500]);
    const before = await arrangementBounds(page);
    expect(before).toHaveLength(6);
    // arrange
    await triggerComponentToolbarAction(page, "autoArrange");
    await waitNextFrame(page, 200);
    await assertArrangement(page, before);
  });
});

test.describe("auto resize align", () => {
  test("resize and arrange shapes", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);
    await createShapeElement(page, [100, -100], [300, 100], Shape.Ellipse);
    await createShapeElement(page, [200, 300], [300, 400], Shape.Square);
    await createShapeElement(page, [400, 100], [500, 200], Shape.Triangle);
    await createShapeElement(
      page,
      [0, 200],
      [100, 300],
      Shape["Rounded rectangle"],
    );

    await page.mouse.click(0, 0);
    await selectAllByKeyboard(page);

    await assertEdgelessSelectedModelRect(page, [0, -100, 500, 500]);
    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 860, 420]);
  });

  test("resize and arrange rotated shapes", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Ellipse);
    await createShapeElement(page, [100, 100], [200, 200], Shape.Square);

    const point = await toViewCoord(page, [100, 100]);
    await page.mouse.click(point[0] + 50, point[1] + 50);
    await page.mouse.move(point[0] - 5, point[1] - 5);
    await page.mouse.down();
    await page.mouse.move(point[0] - 5, point[1] + 45);
    await page.mouse.up();

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 220, 220]);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 420, 200]);
  });

  test("resize and arrange connected shapes", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createShapeElement(page, [100, 100], [200, 200], Shape.Ellipse);
    await createConnectorElement(page, [50, 100], [150, 100]);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 200, 200]);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, -16, 420, 232]);
  });

  test("resize and arrange connector", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createConnectorElement(page, [200, 200], [300, 200]);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 300, 200]);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 320, 200]);
  });

  test("resize and arrange edgeless text", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);

    const point = await toViewCoord(page, [200, -100]);
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(point[0], point[1], {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "a");
    await page.mouse.click(0, 0);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, -125, 395, 225]);
    const before = await arrangementBounds(page);
    expect(before).toHaveLength(2);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertArrangement(page, before, true);
  });

  test("resize and arrange note", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    const noteId = await createNote(page, [200, 200], "Hello World");
    await page.mouse.click(0, 0);
    const note = await getNoteRect(page, noteId);

    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [
      0,
      0,
      note.x + note.w,
      note.y + note.h,
    ]);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [
      0,
      0,
      200 + 20 + (note.w * 200) / note.h,
      200,
    ]);
  });

  test("resize and arrange group", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [200, 300], [300, 400], Shape.Square);
    await createShapeElement(page, [400, 100], [500, 200], Shape.Triangle);
    await selectAllByKeyboard(page);
    await triggerComponentToolbarAction(page, "addGroup");

    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);
    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 500, 400]);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 420, 200]);
  });

  test("resize and arrange frame", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [200, 300], [300, 400], Shape.Square);
    await createShapeElement(page, [400, 100], [500, 200], Shape.Triangle);
    await selectAllByKeyboard(page);
    await createFrameElement(page, [150, 50], [550, 450]);

    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);

    await page.mouse.click(0, 0);
    await selectAllByKeyboard(page);
    await assertEdgelessSelectedModelRect(page, [0, 0, 550, 450]);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertEdgelessSelectedModelRect(page, [0, 0, 420, 200]);
  });

  // TODO mindmap size different on CI
  test("resize and arrange mindmap", async ({ page }) => {
    await commonSetup(page);
    await createShapeElement(page, [0, 0], [100, 100], Shape.Diamond);
    await page.keyboard.press("m");
    await clickView(page, [500, 200]);

    await selectAllByKeyboard(page);
    const box1 = await getSelectedRect(page);
    expect(box1.width).toBeGreaterThan(700);
    expect(box1.height).toBeGreaterThan(300);

    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    const box2 = await getSelectedRect(page);
    expect(box2.width).toBeLessThan(650);
    expect(box2.height).toBeLessThan(210);
  });

  test("resize and arrange shape, note, connector, brush and text", async ({
    page,
  }) => {
    await commonSetup(page);
    // shape
    await createShapeElement(page, [0, 0], [100, 100], Shape.Square);
    await createShapeElement(page, [150, 150], [300, 300], Shape.Ellipse);
    //note
    await createNote(page, [200, 100], "Hello World");
    // connector
    await createConnectorElement(page, [200, -200], [400, -100]);
    // brush
    const start = { x: 400, y: 400 };
    const end = { x: 480, y: 480 };
    await addBasicBrushElement(page, start, end);
    // edgeless text
    const point = await toViewCoord(page, [-100, -100]);
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(point[0], point[1], {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "edgeless text");

    await page.mouse.click(0, 0);
    await selectAllByKeyboard(page);

    await assertEdgelessSelectedModelRect(page, [-125, -200, 793, 500]);
    const before = await arrangementBounds(page);
    expect(before).toHaveLength(6);
    // arrange
    await triggerComponentToolbarAction(page, "autoResize");
    await waitNextFrame(page, 200);
    await assertArrangement(page, before, true);
  });
});
