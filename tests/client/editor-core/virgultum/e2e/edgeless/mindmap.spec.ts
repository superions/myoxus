import { expect } from "@playwright/test";

import { click, clickView } from "../utils/actions/click.js";
import { dragBetweenCoords } from "../utils/actions/drag.js";
import {
  addBasicRectShapeElement,
  autoFit,
  edgelessCommonSetup,
  getSelectedBound,
  getSelectedBoundCount,
  selectElementInEdgeless,
  zoomResetByKeyboard,
} from "../utils/actions/edgeless.js";
import {
  pressBackspace,
  pressEnter,
  pressTab,
  selectAllByKeyboard,
  type,
  undoByKeyboard,
} from "../utils/actions/keyboard.js";
import {
  assertEdgelessSelectedRect,
  assertSelectedBound,
} from "../utils/asserts.js";
import {
  addMindmapNodes,
  createMindMap,
  getMindMapNode,
} from "../utils/mindmap.js";
import { test } from "../utils/playwright.js";

test("elements should be selectable after open mindmap menu", async ({
  page,
}) => {
  await edgelessCommonSetup(page);

  const start = { x: 100, y: 100 };
  const end = { x: 200, y: 200 };
  await addBasicRectShapeElement(page, start, end);

  await page.getByTestId("myoxus-mermaid-edgeless-toolbar-button").click();
  await expect(
    page.getByTestId("myoxus-mermaid-edgeless-template-mindmap-basic"),
  ).toBeAttached();

  await page.mouse.click(start.x + 5, start.y + 5);
  await assertEdgelessSelectedRect(page, [100, 100, 100, 100]);
});

test("undo deletion of mindmap should restore the deleted element", async ({
  page,
}) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);

  await page.keyboard.press("m");
  await clickView(page, [0, 0]);
  await autoFit(page);

  await selectAllByKeyboard(page);
  const mindmapBound = await getSelectedBound(page);

  await pressBackspace(page);

  await selectAllByKeyboard(page);
  expect(await getSelectedBoundCount(page)).toBe(0);

  await undoByKeyboard(page);

  await selectAllByKeyboard(page);
  await assertSelectedBound(page, mindmapBound);
});

test("cannot drag mind map node to itself or its descendants", async ({
  page,
}) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);

  const mindmapId = await createMindMap(page, [0, 1]);
  await addMindmapNodes(page, mindmapId, [0, 1], {
    text: "child node 1",
    children: [
      {
        text: "child node 2",
      },
      {
        text: "child node 3",
      },
    ],
  });

  const { id: node, rect } = await getMindMapNode(page, mindmapId, [0, 1]);
  const { id: childNode3, rect: childRect3 } = await getMindMapNode(
    page,
    mindmapId,
    [0, 1, 0, 1],
  );
  await dragBetweenCoords(
    page,
    { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    { x: childRect3.x + childRect3.w + 10, y: childRect3.y + childRect3.h / 2 },
    {
      steps: 50,
    },
  );

  expect((await getMindMapNode(page, mindmapId, [0, 1])).id).toEqual(node);
  expect((await getMindMapNode(page, mindmapId, [0, 1, 0, 1])).id).toEqual(
    childNode3,
  );
});

test("dropping a Source subtree outside the tree cancels without creating another owner", async ({
  page,
}) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);

  const mindmapId = await createMindMap(page, [0, 1]);
  await addMindmapNodes(page, mindmapId, [0, 1], {
    text: "child node 1",
    children: [
      {
        text: "child node 2",
      },
      {
        text: "child node 3",
      },
    ],
  });

  const { rect } = await getMindMapNode(page, mindmapId, [0, 1]);
  await click(page, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  await dragBetweenCoords(
    page,
    {
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
    },
    {
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2 + 300,
    },
    {
      steps: 50,
    },
  );

  const count = await page.evaluate(
    () =>
      document
        .querySelector("myoxus-edgeless-root")!
        .store.getBlocksByFlavour("myoxus:mermaid").length,
  );
  expect(count).toBe(1);
  expect((await getMindMapNode(page, mindmapId, [0, 1, 0])).text).toBe(
    "child node 1",
  );
  expect((await getMindMapNode(page, mindmapId, [0, 1, 0, 0])).text).toBe(
    "child node 2",
  );
  expect((await getMindMapNode(page, mindmapId, [0, 1, 0, 1])).text).toBe(
    "child node 3",
  );
});

test("allow to type content directly when node has been selected", async ({
  page,
}) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);

  const mindmapId = await createMindMap(page, [0, 0]);
  const { id: nodeId } = await getMindMapNode(page, mindmapId, [0, 1]);

  await clickView(page, [0, 0]);
  await selectElementInEdgeless(page, [nodeId]);
  await type(page, "parent node");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "child node 1");
  await pressEnter(page);
  await pressEnter(page);
  await type(page, "child node 2");
  await pressEnter(page);

  expect((await getMindMapNode(page, mindmapId, [0, 1])).text).toBe(
    "parent node",
  );
  expect((await getMindMapNode(page, mindmapId, [0, 1, 0])).text).toBe(
    "child node 1",
  );
  expect((await getMindMapNode(page, mindmapId, [0, 1, 1])).text).toBe(
    "child node 2",
  );
});
