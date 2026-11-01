import { expect, type Page } from "@playwright/test";

import { dragBetweenCoords } from "../utils/actions/drag.js";
import {
  addNote,
  edgelessCommonSetup,
  setEdgelessTool,
  switchEditorMode,
  mountFramePanelFixture,
} from "../utils/actions/edgeless.js";
import { waitNextFrame } from "../utils/actions/index.js";
import {
  assertEdgelessNonSelectedRect,
  assertEdgelessSelectedRect,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";

test.describe("frame panel", () => {
  test("should update panel when frames change", async ({ page }) => {
    await edgelessCommonSetup(page);
    await mountFramePanelFixture(page);
    const frameCards = page.locator("myoxus-frame-card");
    await expect(frameCards).toHaveCount(0);
    await expect(page.locator(".no-frame-placeholder")).toBeVisible();

    await addNote(page, "hello", 150, 500);

    await page.mouse.click(0, 0);

    await setEdgelessTool(page, "frame");
    await dragBetweenCoords(page, { x: 100, y: 440 }, { x: 600, y: 600 });

    await setEdgelessTool(page, "frame");
    await dragBetweenCoords(page, { x: 50, y: 300 }, { x: 120, y: 400 });
    await waitNextFrame(page);

    const frames = page.locator("myoxus-frame");
    expect(await frames.count()).toBe(2);
    expect(await frameCards.count()).toBe(2);

    await page.mouse.click(50, 300);
    await page.keyboard.press("Delete");
    await waitNextFrame(page);

    expect(await frames.count()).toBe(1);
    expect(await frameCards.count()).toBe(1);
  });

  test.describe("frame panel behavior after mode switch", () => {
    async function setupFrameTest(page: Page) {
      await edgelessCommonSetup(page);
      await mountFramePanelFixture(page);

      await addNote(page, "hello", 150, 500);
      await page.mouse.click(0, 0);
      await waitNextFrame(page, 100);

      await setEdgelessTool(page, "frame");
      await dragBetweenCoords(
        page,
        { x: 100, y: 440 },
        { x: 640, y: 600 },
        { steps: 10 },
      );
      await waitNextFrame(page, 100);

      const edgelessNote = page.locator(
        "myoxus-frame-card myoxus-edgeless-note",
      );
      expect(await edgelessNote.count()).toBe(1);

      return edgelessNote;
    }

    test("should render edgeless note correctly after mode switch", async ({
      page,
    }) => {
      const edgelessNote = await setupFrameTest(page);

      const initialNoteRect = await edgelessNote.boundingBox();
      expect(initialNoteRect).not.toBeNull();

      const {
        width: noteWidth,
        height: noteHeight,
        x: noteX,
        y: noteY,
      } = initialNoteRect!;

      const checkNoteRect = async () => {
        expect(await edgelessNote.count()).toBe(1);

        const newNoteRect = await edgelessNote.boundingBox();
        expect(newNoteRect).not.toBeNull();

        expect(newNoteRect!.width).toBe(noteWidth);
        expect(newNoteRect!.height).toBe(noteHeight);
        expect(newNoteRect!.x).toBe(noteX);
        expect(newNoteRect!.y).toBe(noteY);
      };

      await switchEditorMode(page);
      await page.evaluate(async () => {
        const panel = document.querySelector("myoxus-frame-panel")!;
        panel.host = window.editor.host;
        await panel.updateComplete;
      });
      await checkNoteRect();

      await switchEditorMode(page);
      await page.evaluate(async () => {
        const panel = document.querySelector("myoxus-frame-panel")!;
        panel.host = window.editor.host;
        await panel.updateComplete;
      });
      await checkNoteRect();
    });

    test("should update frame preview when note is moved", async ({ page }) => {
      const edgelessNote = await setupFrameTest(page);

      const initialNoteRect = await edgelessNote.boundingBox();
      expect(initialNoteRect).not.toBeNull();

      await switchEditorMode(page);
      await page.evaluate(async () => {
        const panel = document.querySelector("myoxus-frame-panel")!;
        panel.host = window.editor.host;
        await panel.updateComplete;
      });
      await switchEditorMode(page);
      await page.evaluate(async () => {
        const panel = document.querySelector("myoxus-frame-panel")!;
        panel.host = window.editor.host;
        await panel.updateComplete;
      });

      async function moveNoteAndCheck(
        start: { x: number; y: number },
        end: { x: number; y: number },
        comparison: "greaterThan" | "lessThan",
      ) {
        await dragBetweenCoords(page, start, end);
        await waitNextFrame(page);

        const newNoteRect = await edgelessNote.boundingBox();
        expect(newNoteRect).not.toBeNull();

        if (comparison === "greaterThan") {
          expect(newNoteRect!.x).toBeGreaterThan(initialNoteRect!.x);
          expect(newNoteRect!.y).toBeGreaterThan(initialNoteRect!.y);
        } else {
          expect(newNoteRect!.x).toBeLessThan(initialNoteRect!.x);
          expect(newNoteRect!.y).toBeLessThan(initialNoteRect!.y);
        }
      }

      // Move the note to the right
      await moveNoteAndCheck(
        { x: 150, y: 500 },
        { x: 200, y: 550 },
        "greaterThan",
      );

      // Move the note back to the left
      await moveNoteAndCheck(
        { x: 200, y: 550 },
        { x: 100, y: 450 },
        "lessThan",
      );

      // Move the note diagonally
      await moveNoteAndCheck(
        { x: 100, y: 450 },
        { x: 250, y: 600 },
        "greaterThan",
      );
    });
  });

  test.describe("select and de-select frame", () => {
    async function setupFrameTest(page: Page) {
      await edgelessCommonSetup(page);
      await mountFramePanelFixture(page);

      await addNote(page, "hello", 150, 500);

      await page.mouse.click(0, 0);

      await setEdgelessTool(page, "frame");
      await dragBetweenCoords(page, { x: 100, y: 440 }, { x: 640, y: 600 });
      await waitNextFrame(page);

      const frames = page.locator("myoxus-frame");
      const frameCards = page.locator("myoxus-frame-card");
      expect(await frames.count()).toBe(1);
      expect(await frameCards.count()).toBe(1);

      return { frames, frameCards };
    }

    test("by click on frame card", async ({ page }) => {
      const { frameCards } = await setupFrameTest(page);

      // click on the first frame card
      await frameCards.nth(0).click();
      await assertEdgelessSelectedRect(page, [100, 440, 540, 160]);

      await frameCards.nth(0).click();
      await assertEdgelessNonSelectedRect(page);
      await frameCards.nth(0).click();
      await page
        .locator(".frame-panel-body")
        .click({ position: { x: 5, y: 5 } });
      await assertEdgelessNonSelectedRect(page);
    });
  });
});
