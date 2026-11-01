import { expect, type Page } from "@playwright/test";
import { selectElementInEdgeless } from "./actions/edgeless.js";

export async function createMindMap(page: Page, _coords: [number, number]) {
  const ids = await page.evaluate(() =>
    document
      .querySelector("myoxus-edgeless-root")!
      .store.getBlocksByFlavour("myoxus:mermaid")
      .map((block) => block.model.id),
  );
  await page.keyboard.press("m");
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = await page.evaluate(
        (ids) =>
          document
            .querySelector("myoxus-edgeless-root")!
            .store.getBlocksByFlavour("myoxus:mermaid")
            .find((block) => !ids.includes(block.model.id))?.model.id,
        ids,
      );
      return id;
    })
    .toBeTruthy();
  return id!;
}

/** Read the actual Source-derived shapes; no native tree or test materializer. */
export async function getMindMapNode(
  page: Page,
  mindmapId: string,
  pathOrId: number[] | string,
) {
  return page.evaluate(
    ({ mindmapId, pathOrId }) => {
      const root = document.querySelector("myoxus-edgeless-root");
      if (!root) throw new Error("Edgeless root missing");
      const owner = root.store.getBlock(mindmapId)?.model;
      if (!owner || !("childIds" in owner))
        throw new Error(`Mindmap missing: ${mindmapId}`);
      const nodes = owner.childIds.flatMap((id) => {
        const shape = root.gfx.getElementById(id);
        if (!shape || !("yMap" in shape)) return [];
        const raw = shape.yMap.get("mermaidNodeFamilyData");
        if (typeof raw !== "string" || !raw) return [];
        const family = JSON.parse(raw);
        return family.family === "mindmap"
          ? [{ shape, ...family.payload }]
          : [];
      });
      let node = nodes.find((node) => node.parentKey === null);
      const path = Array.isArray(pathOrId) ? pathOrId : [];
      if (Array.isArray(pathOrId)) {
        for (const index of path.slice(1))
          node = nodes
            .filter((child) => child.parentKey === node?.sourceKey)
            .sort((a, b) => a.order - b.order)[index];
      } else
        node = nodes.find(
          (node) => node.shape.id === pathOrId || node.sourceKey === pathOrId,
        );
      if (!node) throw new Error(`Mindmap node missing: ${pathOrId}`);
      const rect = root.gfx.viewport.toViewBound(node.shape.elementBound);
      return {
        path,
        id: node.shape.id as string,
        key: node.sourceKey as string,
        text: String(node.shape.yMap.get("mermaidNodeLabel")),
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
        children: nodes.filter((child) => child.parentKey === node.sourceKey)
          .length,
      };
    },
    { mindmapId, pathOrId },
  );
}

type NewNodeInfo = { text: string; children?: NewNodeInfo[] };
export async function addMindmapNodes(
  page: Page,
  mindmapId: string,
  path: number[],
  newNode: NewNodeInfo,
): Promise<string> {
  const parent = await getMindMapNode(page, mindmapId, path);
  await selectElementInEdgeless(page, [parent.id]);
  await page.keyboard.press("Tab");
  await page.keyboard.type(newNode.text);
  await page.keyboard.press("Enter");
  const childPath = [...path, parent.children];
  await expect
    .poll(async () => (await getMindMapNode(page, mindmapId, path)).children)
    .toBe(parent.children + 1);
  const child = await getMindMapNode(page, mindmapId, childPath);
  for (const nested of newNode.children ?? [])
    await addMindmapNodes(page, mindmapId, childPath, nested);
  return child.id;
}
