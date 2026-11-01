import { expect, type Page } from "@playwright/test";
import { Bound } from "@virgultum/editor/global/gfx";

import {
  autoFit,
  captureHistory,
  cutByKeyboard,
  dblclickView,
  dragBetweenIndices,
  edgelessCommonSetup,
  enterPlaygroundRoom,
  getEdgelessSelectedRect,
  getIds,
  getInlineSelectionIndex,
  initEmptyEdgelessState,
  pasteByKeyboard,
  pressArrowLeft,
  pressArrowRight,
  pressArrowUp,
  pressBackspace,
  pressEnter,
  pressEscape,
  pressShiftTab,
  pressTab,
  redoByKeyboard,
  selectAllByKeyboard,
  selectElementInEdgeless,
  setEdgelessTool,
  setViewportCenter,
  switchEdgelessTheme,
  switchEditorMode,
  toViewCoord,
  type,
  undoByKeyboard,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertBlockChildrenIds,
  assertBlockFlavour,
  assertBlockTextContent,
  assertRichTextInlineDeltas,
  assertRichTextInlineRange,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";
import { getFormatBar } from "../utils/query.js";

async function getEdgelessTextModelRect(page: Page) {
  const xywh = await page
    .locator("myoxus-edgeless-text")
    .evaluate((block) => block.model.xywh);
  return Bound.deserialize(xywh);
}

test.describe("edgeless text block", () => {
  test.beforeEach(async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyEdgelessState(page);
    await switchEditorMode(page);
  });

  test("add text block in default mode", async ({ page }) => {
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);

    // https://github.com/example/virgultum/pull/8574
    await pressBackspace(page);

    await type(page, "aaa");
    await pressEnter(page);
    await type(page, "bbb");
    await pressEnter(page);
    await type(page, "ccc");

    await assertBlockFlavour(page, 4, "myoxus:edgeless-text");
    await assertBlockFlavour(page, 5, "myoxus:paragraph");
    await assertBlockFlavour(page, 6, "myoxus:paragraph");
    await assertBlockFlavour(page, 7, "myoxus:paragraph");
    await assertBlockChildrenIds(page, "4", ["5", "6", "7"]);
    await assertBlockTextContent(page, 5, "aaa");
    await assertBlockTextContent(page, 6, "bbb");
    await assertBlockTextContent(page, 7, "ccc");

    await dragBetweenIndices(page, [1, 1], [3, 2]);
    await captureHistory(page);
    await pressBackspace(page);
    await assertBlockChildrenIds(page, "4", ["5"]);
    await assertBlockTextContent(page, 5, "ac");

    await undoByKeyboard(page);
    await assertBlockChildrenIds(page, "4", ["5", "6", "7"]);
    await assertBlockTextContent(page, 5, "aaa");
    await assertBlockTextContent(page, 6, "bbb");
    await assertBlockTextContent(page, 7, "ccc");

    const { boldBtn } = getFormatBar(page);
    await boldBtn.click();
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: "a",
        },
        {
          insert: "aa",
          attributes: {
            bold: true,
          },
        },
      ],
      1,
    );
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: "bbb",
          attributes: {
            bold: true,
          },
        },
      ],
      2,
    );
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: "cc",
          attributes: {
            bold: true,
          },
        },
        {
          insert: "c",
        },
      ],
      3,
    );

    await pressArrowRight(page);
    await assertRichTextInlineRange(page, 3, 2);
    await pressArrowUp(page);
    await assertRichTextInlineRange(page, 2, 2);
  });

  test("resolves default text color when the edgeless theme changes", async ({
    page,
  }) => {
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);

    await type(page, "text color");
    await pressEscape(page);
    await pressEscape(page);

    const text = page.locator("myoxus-edgeless-text");
    await expect(text).toBeVisible();
    await page.mouse.click(130, 140);
    await waitNextFrame(page);

    const colorButton = page.getByRole("button", { name: "Text color" });
    const activeColorButton = page.locator("edgeless-color-button[active]");
    const getRenderedTextColor = () =>
      text
        .locator(".myoxus-block-children-container")
        .first()
        .evaluate((element) =>
          (element as HTMLElement).style.getPropertyValue(
            "--edgeless-text-color",
          ),
        );

    await colorButton.click();
    await expect(activeColorButton.getByLabel("Black")).toHaveCount(1);
    await expect
      .poll(async () => activeColorButton.locator("svg").getAttribute("fill"))
      .toBe(await getRenderedTextColor());
    await expect(activeColorButton.locator("svg")).toHaveCSS(
      "fill",
      "rgb(0, 0, 0)",
    );

    await pressEscape(page);
    await switchEdgelessTheme(page, "dark");
    await page.mouse.click(130, 140);
    await waitNextFrame(page);
    await colorButton.click({ force: true });

    await expect
      .poll(async () => activeColorButton.locator("svg").getAttribute("fill"))
      .toBe(await getRenderedTextColor());
    await expect(activeColorButton.locator("svg")).toHaveCSS(
      "fill",
      "rgb(255, 255, 255)",
    );
  });

  test("edgeless text width auto-adjusting", async ({ page }) => {
    await setEdgelessTool(page, "default");
    const point = await toViewCoord(page, [0, 0]);
    await page.mouse.dblclick(point[0], point[1], {
      delay: 100,
    });
    await waitNextFrame(page);
    const initial = await getEdgelessTextModelRect(page);

    await type(page, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await waitNextFrame(page, 1000);
    const oneLine = await getEdgelessTextModelRect(page);
    expect(oneLine.w).toBeGreaterThan(initial.w);
    expect(oneLine.h).toBeCloseTo(initial.h);

    await type(page, "\nbbb");
    const twoLines = await getEdgelessTextModelRect(page);
    expect(twoLines.w).toBeCloseTo(oneLine.w);
    expect(twoLines.h).toBeGreaterThan(oneLine.h);
    await type(page, "\nccccccccccccccccccccccccccccccccccccccccccccccccc");
    await waitNextFrame(page, 1000);

    const threeLines = await getEdgelessTextModelRect(page);
    expect(threeLines.w).toBeGreaterThan(twoLines.w);
    expect(threeLines.h).toBeGreaterThan(twoLines.h);
  });

  test("When creating edgeless text, if the input is empty, it will be automatically deleted", async ({
    page,
  }) => {
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);
    let block = page.locator('myoxus-edgeless-text[data-block-id="4"]');
    expect(await block.isVisible()).toBe(true);
    await page.mouse.click(0, 0);
    expect(await block.isVisible()).toBe(false);

    block = page.locator('myoxus-edgeless-text[data-block-id="6"]');
    expect(await block.isVisible()).not.toBe(true);
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    expect(await block.isVisible()).toBe(true);
    await type(page, "\na");
    expect(await block.isVisible()).toBe(true);
    await page.mouse.click(0, 0);
    expect(await block.isVisible()).not.toBe(false);
  });

  test("edgeless text should maintain selection when deleting across multiple lines", async ({
    page,
  }) => {
    // https://github.com/example/virgultum/pull/7443

    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "aaaa\nbbbb");
    await assertBlockTextContent(page, 5, "aaaa");
    await assertBlockTextContent(page, 6, "bbbb");

    await pressArrowLeft(page);
    await page.keyboard.down("Shift");
    await pressArrowLeft(page, 3);
    await pressArrowUp(page);
    await pressArrowRight(page);
    await page.keyboard.up("Shift");
    await pressBackspace(page);
    await assertBlockTextContent(page, 5, "ab");
    await type(page, "sss\n");
    await assertBlockTextContent(page, 5, "asss");
    await assertBlockTextContent(page, 7, "b");
  });

  test("edgeless text should not blur after pressing backspace", async ({
    page,
  }) => {
    // https://github.com/example/virgultum/pull/7555

    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "a");
    await assertBlockTextContent(page, 5, "a");
    await pressBackspace(page);
    await type(page, "b");
    await assertBlockTextContent(page, 5, "b");
  });

  test("min width limit for embed block", async ({ page }) => {
    await setEdgelessTool(page, "default");
    const point = await toViewCoord(page, [0, 0]);
    await page.mouse.dblclick(point[0], point[1], {
      delay: 100,
    });
    await waitNextFrame(page, 2000);

    await type(page, "@");
    await pressEnter(page);
    await waitNextFrame(page, 200);
    await expect(page.locator("myoxus-reference")).toBeVisible();
    await autoFit(page);

    await page.locator("myoxus-reference").hover();
    await page.getByLabel("Switch view").click();
    await page.getByTestId("link-to-card").click();
    await autoFit(page);

    await waitNextFrame(page);

    await expect(page.locator("myoxus-embed-linked-doc-block")).toBeVisible();

    await page.mouse.click(0, 0);
    const textBlock = page.locator("myoxus-edgeless-text");
    const textId = await textBlock.getAttribute("data-block-id");
    if (!textId) throw new Error("Missing Edgeless text fixture ID");
    await selectElementInEdgeless(page, [textId]);
    await waitNextFrame(page, 200);
    const selectedRect0 = await getEdgelessSelectedRect(page);

    // from right to left
    await page.mouse.move(
      selectedRect0.x + selectedRect0.width,
      selectedRect0.y + selectedRect0.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      selectedRect0.x,
      selectedRect0.y + selectedRect0.height / 2,
      {
        steps: 10,
      },
    );
    await page.mouse.up();

    const selectedRect1 = await getEdgelessSelectedRect(page);
    expect(selectedRect1.width).toBeCloseTo(selectedRect0.width);
    expect(selectedRect1.height).toBeCloseTo(selectedRect0.height);
    // from left to right
    await page.mouse.move(
      selectedRect1.x + selectedRect1.width,
      selectedRect1.y + selectedRect1.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      selectedRect0.x + selectedRect0.width + 45,
      selectedRect1.y + selectedRect1.height / 2,
      {
        steps: 10,
      },
    );
    await page.mouse.up();

    const selectedRect2 = await getEdgelessSelectedRect(page);
    expect(selectedRect2.width).toBeCloseTo(selectedRect1.width + 45);
    expect(selectedRect2.height).toBeCloseTo(selectedRect1.height);
    expect(selectedRect2.x).toBeCloseTo(selectedRect1.x);
    expect(selectedRect2.y).toBeCloseTo(selectedRect1.y);
  });

  test("cut edgeless text", async ({ page }) => {
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "aaaa\nbbbb\ncccc");

    const edgelessText = page.locator("myoxus-edgeless-text");
    const paragraph = page.locator("myoxus-edgeless-text myoxus-paragraph");

    expect(await edgelessText.count()).toBe(1);
    expect(await paragraph.count()).toBe(3);

    await pressEscape(page, 3);
    await page.mouse.click(900, 800);
    await edgelessText.click();
    await expect
      .poll(() =>
        page.locator("myoxus-edgeless-root").evaluate((root) => ({
          editing: root.gfx.selection.editing,
          ids: root.gfx.selection.selectedElements.map((e) => e.id),
        })),
      )
      .toEqual({
        editing: false,
        ids: [await edgelessText.getAttribute("data-block-id")],
      });
    await cutByKeyboard(page);
    await expect(edgelessText).toHaveCount(0);
    await expect(paragraph).toHaveCount(0);

    await pasteByKeyboard(page);
    await expect(edgelessText).toHaveCount(1);
    await expect(paragraph).toHaveCount(3);
  });

  test("latex in edgeless text", async ({ page }) => {
    await setEdgelessTool(page, "default");
    await page.mouse.dblclick(130, 140, {
      delay: 100,
    });
    await waitNextFrame(page);
    await type(page, "$$bbb$$ ");
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: " ",
          attributes: {
            latex: "bbb",
          },
        },
      ],
      1,
    );

    await page.locator("myoxus-latex-node").click();
    await waitNextFrame(page);
    await type(page, "ccc");
    const menu = page.locator("latex-editor-menu");
    const confirm = menu.locator(".latex-editor-confirm");
    await confirm.click();
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: " ",
          attributes: {
            latex: "bbbccc",
          },
        },
      ],
      1,
    );

    await page.locator("myoxus-latex-node").click();
    await page.locator(".latex-editor-hint").click();
    await type(page, "sss");
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: " ",
          attributes: {
            latex: "bbbccc",
          },
        },
      ],
      1,
    );
    await page.locator("latex-editor-unit").click();
    await selectAllByKeyboard(page);
    await type(page, "sss");
    await confirm.click();
    await assertRichTextInlineDeltas(
      page,
      [
        {
          insert: " ",
          attributes: {
            latex: "sss",
          },
        },
      ],
      1,
    );
  });

  test("edgeless text should be able to delete line", async ({ page }) => {
    await setViewportCenter(page, [100, -100]);
    await dblclickView(page, [100, -100]);
    // 5: aaa
    // 6:     bbb
    // 7: ccc|
    {
      await type(page, "aaa");
      await pressEnter(page);
      await pressTab(page);
      await type(page, "bbb");
      await pressEnter(page);
      await pressShiftTab(page);
      await type(page, "ccc");
    }

    // 5: aaa
    // 6:     bbb|
    await pressBackspace(page, 4);
    expect(await getIds(page)).not.toContain(7);
    await assertBlockTextContent(page, 5, "aaa");
    await assertBlockTextContent(page, 6, "bbb");
    expect(await getInlineSelectionIndex(page)).toBe(3);

    // 5: |aaa
    // 6:     bbb
    {
      await pressArrowUp(page);
      await pressArrowLeft(page, 3);
      await pressBackspace(page);
    }

    await assertBlockTextContent(page, 5, "aaa");
    await assertBlockTextContent(page, 6, "bbb");
    expect(await getInlineSelectionIndex(page)).toBe(0);

    // 6: |bbb
    {
      await pressArrowRight(page, 3);
      await pressBackspace(page, 4);
    }

    expect(await getIds(page)).not.toContain(7);
    await assertBlockTextContent(page, 6, "bbb");
    expect(await getInlineSelectionIndex(page)).toBe(0);
  });
});

test("undo/redo should work when changing text color", async ({ page }) => {
  await edgelessCommonSetup(page);
  await dblclickView(page, [100, 100]);
  await type(page, "abc");
  await pressEscape(page, 3);
  await waitNextFrame(page);

  const edgelessText = page.locator("myoxus-edgeless-text");
  await edgelessText.click();

  const getTextColor = async () => {
    return edgelessText.locator('span[data-v-text="true"]').evaluate((el) => {
      return getComputedStyle(el).color;
    });
  };
  const colorPanel = page.locator("edgeless-color-picker-button");

  let prevTextColor = await getTextColor();

  // preset color
  {
    await colorPanel.click();
    await colorPanel.getByLabel("LightRed").click();
    expect(await getTextColor()).not.toBe(prevTextColor);

    await undoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getTextColor()).toBe(prevTextColor);

    await redoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getTextColor()).not.toBe(prevTextColor);
  }

  prevTextColor = await getTextColor();

  // custom color
  {
    await pressEscape(page);
    await edgelessText.click();
    await colorPanel.click();
    await colorPanel.locator("edgeless-color-custom-button").click();
    await page.locator(".color-palette").click({
      position: {
        x: 100,
        y: 100,
      },
    });
    await pressEscape(page);

    expect(await getTextColor()).not.toBe(prevTextColor);
    await undoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getTextColor()).toBe(prevTextColor);

    await redoByKeyboard(page);
    await waitNextFrame(page);
    expect(await getTextColor()).not.toBe(prevTextColor);
  }
});
