// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, type Page } from "@playwright/test";

/** Open a document tool through the English-locale product controls. */
export async function openDocumentTool(page: Page, toolId: string) {
  const panelToggle = page.getByTestId("context-panel-toggle");
  if ((await panelToggle.getAttribute("aria-expanded")) !== "true") {
    await panelToggle.click();
  }
  await page.getByTestId("header-dropDownButton").click();
  await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
  const tool = page.getByTestId(`workbench-tool-menu-${toolId}`);
  if ((await tool.getAttribute("data-checked")) !== "true") {
    await tool.focus();
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const surface = page.getByTestId(`context-surface-${toolId}`);
  await expect(surface).toBeVisible();
  const expand = surface.locator("button[aria-expanded]");
  if ((await expand.getAttribute("aria-expanded")) !== "true") {
    await expand.click();
  }
  return surface;
}
