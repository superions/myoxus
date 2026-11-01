// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, type Locator, type Page } from "@playwright/test";

import { typeSlashCommand } from "./virgultum-mermaid-block-doc-helpers";

export const FATAL_MERMAID_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /is not a function/i,
  /ReferenceError/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];

export async function writeMermaidSource(
  sourceEditor: Locator,
  source: string,
  options: { exact?: boolean } = {},
) {
  await expect(sourceEditor).toBeVisible({ timeout: 10_000 });
  await sourceEditor.fill(source);
  await sourceEditor.blur();
  if (options.exact ?? true) {
    await expect(sourceEditor).toHaveValue(
      new RegExp(`${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
  } else {
    await expect(sourceEditor).toHaveValue(new RegExp(source.split("\n")[0]));
  }
}

export async function insertEditableMermaidBlock(page: Page): Promise<{
  mermaidBlock: Locator;
  sourceEditor: Locator;
  visualCanvas: Locator;
}> {
  await typeSlashCommand(page, "/mermaid");
  await page.getByTestId("slash-menu-item-mermaid-flowchart-basic").click();

  const mermaidBlock = page.locator("myoxus-mermaid").first();
  const sourceEditor = mermaidBlock.getByRole("textbox", {
    name: "Mermaid source",
  });
  const visualCanvas = mermaidBlock
    .locator(".myoxus-mermaid-gfx-viewport")
    .first();
  await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
  await expect(visualCanvas).toBeVisible({ timeout: 10_000 });
  return { mermaidBlock, sourceEditor, visualCanvas };
}

export async function mermaidBlockSource(page: Page): Promise<string> {
  return page.evaluate(() => {
    const block = document.querySelector("myoxus-mermaid") as {
      model?: { props?: { source?: { toString?: () => string } } };
      std?: {
        store?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: { props?: { source?: { toString?: () => string } } };
          }>;
        };
      };
    } | null;
    const blockSource = block?.model?.props?.source?.toString?.();
    if (blockSource !== undefined) return blockSource;
    const ownerSource = block?.std?.store
      ?.getBlocksByFlavour?.("myoxus:mermaid")
      ?.at(0)
      ?.model?.props?.source?.toString?.();
    if (ownerSource !== undefined) return ownerSource;
    const root = document.querySelector("myoxus-edgeless-root") as {
      gfx?: {
        doc?: {
          getBlocksByFlavour?: (flavour: string) => Array<{
            model?: { props?: { source?: { toString?: () => string } } };
          }>;
        };
      };
    } | null;
    return (
      root?.gfx?.doc
        ?.getBlocksByFlavour?.("myoxus:mermaid")
        ?.at(0)
        ?.model?.props?.source?.toString?.() ?? ""
    );
  });
}

export async function expectMermaidSourceAfterReload(
  page: Page,
  expectedSourceFragment: string,
) {
  await expect
    .poll(() => mermaidBlockSource(page))
    .toContain(expectedSourceFragment);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("myoxus-mermaid").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => mermaidBlockSource(page), { timeout: 20_000 })
    .toContain(expectedSourceFragment);
}

export async function expectEditableGfx(
  mermaidBlock: Locator,
  diagramType: string,
) {
  await expect(
    mermaidBlock.locator(
      `.myoxus-mermaid-gfx-editor[data-diagram-type="${diagramType}"][data-mermaid-gfx-editable="true"]`,
    ),
  ).toBeVisible({ timeout: 10_000 });
}
