import { test } from "@myoxus-test/kit/playwright";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import { type, waitForEditorLoad } from "@myoxus-test/kit/utils/page-logic";
import { expect } from "@playwright/test";

import { createNewPage, gotoContentFromTitle } from "./utils";

test.describe("Code Block Preview", () => {
  test("enable html preview", async ({ page }) => {
    const code = page.locator("myoxus-code");

    await openHomePage(page);
    await createNewPage(page);
    await waitForEditorLoad(page);
    await gotoContentFromTitle(page);
    await type(page, "```html aaa");
    await code.hover({
      position: {
        x: 155,
        y: 65,
      },
    });
    await page.getByText("Preview").click();
    await expect(
      page
        .locator('iframe[title="HTML Preview"]')
        .contentFrame()
        .getByText("aaa"),
    ).toBeVisible();
  });

  test("enable mermaid preview", async ({ page }) => {
    const code = page.locator("myoxus-code");
    const mermaidSvg = page.locator("mermaid-preview .mermaid-preview-svg svg");

    await openHomePage(page);
    await createNewPage(page);
    await waitForEditorLoad(page);
    await gotoContentFromTitle(page);
    await type(page, "```mermaid graph TD;A-->B");
    await code.hover({
      position: {
        x: 155,
        y: 65,
      },
    });
    await page.getByText("Preview").click();
    await expect(mermaidSvg).toBeVisible();
  });

  test("enable typst preview", async ({ page }) => {
    const code = page.locator("myoxus-code");
    const typstPreview = page.locator("typst-preview");

    await openHomePage(page);
    await createNewPage(page);
    await waitForEditorLoad(page);
    await gotoContentFromTitle(page);
    await type(page, "```typst = Title");
    await code.hover({
      position: {
        x: 155,
        y: 65,
      },
    });
    await page.getByText("Preview").click();
    await expect(typstPreview).toBeVisible();
  });

  test("change lang without preview", async ({ page }) => {
    const code = page.locator("myoxus-code");
    const preview = page.locator("myoxus-code .myoxus-code-block-preview");

    await openHomePage(page);
    await createNewPage(page);
    await waitForEditorLoad(page);
    await gotoContentFromTitle(page);
    await type(page, "```html aaa");

    await code.hover({
      position: {
        x: 155,
        y: 65,
      },
    });
    await page.getByText("Preview").click();
    await expect(preview).toBeVisible();

    // change to lang without preview support
    await page.getByTestId("lang-button").click();
    await page.getByRole("button", { name: "ABAP" }).click();

    await expect(preview).toBeHidden();

    // change back to html
    await page.getByTestId("lang-button").click();
    await page.getByRole("button", { name: "HTML", exact: true }).click();

    await expect(preview).toBeVisible();
  });
});
