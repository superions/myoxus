import {
  clickEdgelessModeButton,
  locateEditorContainer,
  locateToolbar,
} from "@myoxus-test/kit/utils/editor";
import { openHomePage } from "@myoxus-test/kit/utils/load-page";
import {
  clickNewPageButton,
  waitForEmptyEditor,
} from "@myoxus-test/kit/utils/page-logic";
import { expect, type Page, test } from "@playwright/test";

const TEST_SPOTIFY_URL =
  "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5";

const EMBED_EDGELESS_IFRAME_BLOCK = "myoxus-embed-edgeless-iframe-block";

test.beforeEach(async ({ page }) => {
  await openHomePage(page);
  await clickNewPageButton(page);
  await waitForEmptyEditor(page);
  await page.locator("myoxus-paragraph v-line div").click();
});

test.describe("embed iframe block", () => {
  async function openToolbarAndSwitchView(page: Page) {
    // expect toolbar to be visible
    const toolbar = locateToolbar(page);
    await expect(toolbar).toBeVisible();

    // switch to inline view
    await page.getByRole("button", { name: "Switch view" }).click();
  }

  test.describe("edgeless mode", () => {
    // add embed iframe block to edgeless mode by cmdk menu
    async function addEmbedEdgelessIframeBlock(page: Page) {
      // switch to edgeless mode
      await clickEdgelessModeButton(page);
      const container = locateEditorContainer(page);
      await container.click();

      // press @ to trigger the menu
      await page.keyboard.press("@");

      // type spotify url
      await page.keyboard.type(TEST_SPOTIFY_URL);

      // click item which data-testid='cmdk-label'
      await page
        .locator(
          `[data-testid="cmdk-label"][data-value="external-link:${TEST_SPOTIFY_URL}"]`,
        )
        .click();

      // expect the embed iframe block count is 1
      const embedEdgelessIframeBlock = page.locator(
        EMBED_EDGELESS_IFRAME_BLOCK,
      );
      await expect(embedEdgelessIframeBlock).toHaveCount(1);
    }

    test("insert embed iframe block to edgeless directly", async ({ page }) => {
      await addEmbedEdgelessIframeBlock(page);
    });

    test("convert between embed view and card view", async ({ page }) => {
      await addEmbedEdgelessIframeBlock(page);

      await openToolbarAndSwitchView(page);
      await page.getByRole("button", { name: "Card view" }).click();

      // expect the embed iframe block count is 0
      const embedEdgelessIframeBlock = page.locator(
        EMBED_EDGELESS_IFRAME_BLOCK,
      );
      await expect(embedEdgelessIframeBlock).toHaveCount(0);

      // expect the bookmark block count is 1
      const bookmarkEdgelessBlock = page.locator("myoxus-edgeless-bookmark");
      await expect(bookmarkEdgelessBlock).toHaveCount(1);

      // click the bookmark block
      await bookmarkEdgelessBlock.click();

      // convert back to embed view
      await openToolbarAndSwitchView(page);
      await page.getByRole("button", { name: "Embed view" }).click();

      // expect the embed iframe block count is 1
      await expect(embedEdgelessIframeBlock).toHaveCount(1);
    });
  });
});
