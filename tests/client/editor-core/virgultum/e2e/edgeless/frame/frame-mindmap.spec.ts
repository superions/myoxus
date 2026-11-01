import { expect } from "@playwright/test";

import { dragBetweenCoords } from "../../utils/actions/drag.js";
import {
  autoFit,
  createFrame,
  edgelessCommonSetup,
  getFirstContainerId,
  setEdgelessTool,
  triggerComponentToolbarAction,
  zoomResetByKeyboard,
} from "../../utils/actions/edgeless.js";
import { pressEscape } from "../../utils/actions/keyboard.js";
import {
  assertContainerOfElements,
  assertRectExist,
} from "../../utils/asserts.js";
import { getMindMapNode } from "../../utils/mindmap.js";
import { test } from "../../utils/playwright.js";

test("dragging a Source mindmap owner reparents the whole map without detaching its nodes", async ({
  page,
}) => {
  await edgelessCommonSetup(page);
  await zoomResetByKeyboard(page);
  await createFrame(page, [100, 150], [600, 650]);
  const frameId = await getFirstContainerId(page);
  await pressEscape(page);
  await triggerComponentToolbarAction(page, "addMindmap");
  const mindmapId = await getFirstContainerId(page, [frameId]);

  const children = await page.evaluate((id) => {
    const root = document.querySelector("myoxus-edgeless-root");
    const map = root?.gfx.getElementById(id);
    if (!map || !("childIds" in map)) throw new Error("Mindmap missing");
    return [...map.childIds];
  }, mindmapId);
  expect(children.length).toBeGreaterThan(1);
  await autoFit(page);
  await setEdgelessTool(page, "default");

  const frame = await page
    .locator(`myoxus-frame[data-block-id="${frameId}"]`)
    .boundingBox();
  assertRectExist(frame);
  expect(frame.x).toBeGreaterThan(0);
  expect(frame.y).toBeGreaterThan(0);
  const ownerPoint = () =>
    page.evaluate((id) => {
      const root = document.querySelector("myoxus-edgeless-root")!;
      const owner = root.store.getBlock(id)!.model;
      if (!("elementBound" in owner))
        throw new Error("Source owner has no bounds");
      const bound = root.gfx.viewport.toViewBound(owner.elementBound);
      return { x: bound.x + 10, y: bound.y + bound.h - 10 };
    }, mindmapId);
  await dragBetweenCoords(page, await ownerPoint(), {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  });
  await assertContainerOfElements(page, [mindmapId], frameId);
  const initialRoot = await getMindMapNode(page, mindmapId, [0]);

  // Drop ownership follows the pointer, not an assumed fraction of the whole
  // map's bounds. Keep both destinations inside the actual browser viewport.
  await dragBetweenCoords(page, await ownerPoint(), {
    x: frame.x / 2,
    y: frame.y / 2,
  });
  await assertContainerOfElements(page, [mindmapId], null);
  await assertContainerOfElements(page, children, mindmapId);

  const movedRoot = await getMindMapNode(page, mindmapId, [0]);
  expect(movedRoot.id).toBe(initialRoot.id);
  expect(movedRoot.text).toBe(initialRoot.text);
  await dragBetweenCoords(page, await ownerPoint(), {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  });
  await assertContainerOfElements(page, [mindmapId], frameId);
  await assertContainerOfElements(page, children, mindmapId);
});
