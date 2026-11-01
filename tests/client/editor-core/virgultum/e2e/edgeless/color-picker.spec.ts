import { expect, type Page } from "@playwright/test";

import {
  addBasicShapeElement,
  Shape,
  switchEditorMode,
  triggerComponentToolbarAction,
} from "../utils/actions/edgeless.js";
import { undoByKeyboard } from "../utils/actions/keyboard.js";
import {
  enterPlaygroundRoom,
  initEmptyEdgelessState,
} from "../utils/actions/misc.js";
import { test } from "../utils/playwright.js";

async function setupColorControl(page: Page) {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  const id = await addBasicShapeElement(
    page,
    { x: 100, y: 100 },
    { x: 150, y: 200 },
    Shape.Square,
  );
  await triggerComponentToolbarAction(page, "changeShapeFillColor");
  return {
    input: page.getByRole("textbox", { name: "Fill color", exact: true }),
    color: () =>
      page.evaluate((id) => {
        const root = document.querySelector("myoxus-edgeless-root");
        const shape = root?.gfx.getElementById(id);
        if (!shape || !("fillColor" in shape))
          throw new Error("Shape not found");
        return shape.fillColor;
      }, id),
  };
}

test("should close color-picker panel when clicking outside", async ({
  page,
}) => {
  const { input } = await setupColorControl(page);
  await input.click();
  const picker = page.getByRole("slider").first();
  await expect(picker).toBeVisible();
  await page.mouse.click(0, 0);
  await expect(picker).toBeHidden();
});

test("custom color and alpha survive field blur and undo", async ({ page }) => {
  const { input, color } = await setupColorControl(page);
  await input.fill("#e03131");
  await input.press("Tab");
  await expect.poll(color).toBe("#e03131");

  await input.fill("#e0313180");
  await input.press("Tab");
  await expect.poll(color).toBe("#e0313180");
  await page
    .locator("myoxus-edgeless-root")
    .click({ position: { x: 600, y: 50 } });
  await undoByKeyboard(page);
  await expect.poll(color).toBe("#e03131");
});
