// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Locator, type Page } from "@playwright/test";

export async function architectureBlankPoint(
  mermaidBlock: Locator,
): Promise<{ x: number; y: number }> {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      _findVisualNodeByClientPoint?: (
        clientX: number,
        clientY: number,
      ) => string;
      querySelector: Element["querySelector"];
    };
    const viewport = block.querySelector(".myoxus-mermaid-gfx-viewport");
    const rect = viewport?.getBoundingClientRect();
    if (!rect || !block._findVisualNodeByClientPoint) {
      throw new Error("Architecture canvas hit-test is not available");
    }
    const candidates = [
      { x: 28, y: 28 },
      { x: 28, y: rect.height - 28 },
      { x: rect.width - 28, y: 28 },
      { x: rect.width - 28, y: rect.height - 28 },
      { x: rect.width / 2, y: 28 },
    ];
    const point = candidates.find(
      (candidate) =>
        !block._findVisualNodeByClientPoint!(
          rect.left + candidate.x,
          rect.top + candidate.y,
        ),
    );
    if (!point) throw new Error("No blank Architecture canvas point found");
    return point;
  });
}

export async function largestVisibleArchitectureEdgelessFrame(
  page: Page,
): Promise<Locator> {
  const frameIndex = await page.locator("myoxus-frame").evaluateAll(
    (frames) =>
      frames
        .map((frame, index) => {
          const rect = frame.getBoundingClientRect();
          return { area: rect.width * rect.height, index };
        })
        .sort((a, b) => b.area - a.area)[0]?.index ?? 0,
  );
  return page.locator("myoxus-frame").nth(frameIndex);
}

async function architectureEdgelessNodeCenter(
  managedFrame: Locator,
  nodeId: string,
): Promise<{ x: number; y: number }> {
  return managedFrame.evaluate((frameElement, targetNodeId) => {
    const frame = frameElement as unknown as {
      gfx?: {
        viewport?: {
          left?: number;
          top?: number;
          toViewCoord?: (x: number, y: number) => [number, number];
        };
      };
      model?: {
        childIds?: string[];
        childElements?: Array<{
          id?: string;
          xywh?: string;
          yMap?: { get?: (key: string) => unknown };
        }>;
        surface?: {
          getElementById?: (id: string) => {
            id?: string;
            xywh?: string;
            yMap?: { get?: (key: string) => unknown };
          } | null;
        };
      };
    };
    const childElements = frame.model?.childElements ?? [];
    const childIds = frame.model?.childIds ?? [];
    const elements = [
      ...childElements,
      ...childIds
        .map((id) => frame.model?.surface?.getElementById?.(id) ?? null)
        .filter((element): element is NonNullable<typeof element> =>
          Boolean(element),
        ),
    ].filter(
      (element, index, all) =>
        all.findIndex((candidate) => candidate.id === element.id) === index,
    );
    const node = elements.find(
      (candidate) =>
        String(candidate.yMap?.get?.("mermaidNodeId") ?? "") === targetNodeId &&
        JSON.stringify(
          candidate.yMap?.get?.("mermaidNodeFamilyData") ?? "",
        ).includes("architecture"),
    );
    if (!node?.xywh) {
      throw new Error(`Architecture node ${targetNodeId} has no GFX bounds`);
    }
    const [x, y, width, height] = JSON.parse(node.xywh) as [
      number,
      number,
      number,
      number,
    ];
    const viewport = frame.gfx?.viewport;
    const [localX, localY] = viewport?.toViewCoord?.(
      x + width / 2,
      y + height / 2,
    ) ?? [0, 0];
    return {
      x: localX + (viewport?.left ?? 0),
      y: localY + (viewport?.top ?? 0),
    };
  }, nodeId);
}

export async function selectArchitectureEdgelessNode(
  page: Page,
  managedFrame: Locator,
  nodeId: string,
): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  const center = await architectureEdgelessNodeCenter(managedFrame, nodeId);
  await page.mouse.click(center.x, center.y);
}

export async function architectureProjectionSnapshot(mermaidBlock: Locator) {
  return mermaidBlock.evaluate((element) => {
    const block = element as unknown as {
      _lastValidGfxPreview?: {
        visualModel?: {
          familyData?: {
            family?: string;
            payload?: {
              config?: Record<string, boolean | number>;
            };
            version?: number;
          };
          nodes?: Array<{
            height: number;
            id: string;
            width: number;
            x: number;
            y: number;
          }>;
          subgraphs?: Array<{
            height: number;
            id: string;
            width: number;
            x: number;
            y: number;
          }>;
        };
      };
    };
    const visualModel = block._lastValidGfxPreview?.visualModel;
    return {
      config:
        visualModel?.familyData?.family === "architecture" &&
        visualModel.familyData.version === 1
          ? (visualModel.familyData.payload?.config ?? {})
          : {},
      nodes: visualModel?.nodes ?? [],
      subgraphs: visualModel?.subgraphs ?? [],
    };
  });
}
