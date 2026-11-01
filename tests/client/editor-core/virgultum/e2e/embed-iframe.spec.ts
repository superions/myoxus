import { expect, type Page } from "@playwright/test";

import { type } from "./utils/actions/keyboard.js";
import {
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
  waitNextFrame,
} from "./utils/actions/misc.js";
import { test } from "./utils/playwright.js";

const SPOTIFY_URL = "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5";
const SPOTIFY_IFRAME_URL =
  "https://open.spotify.com/embed/episode/7makk4oTQel546B0PZlDM5";
const NON_EMBEDDABLE_MYOXUS_URL = "https://app.myoxus.de/";

const EMBED_IFRAME_BLOCK = "myoxus-embed-iframe-block";
const IDLE_CARD = "embed-iframe-idle-card";
const LINK_INPUT_POPUP = "embed-iframe-link-input-popup";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/worker/link-preview", async (route) => {
    await route.fulfill({
      json: {
        url: route.request().postDataJSON()?.url ?? "",
      },
    });
  });

  await page.route("https://open.spotify.com/oembed**", async (route) => {
    await route.fulfill({
      json: {
        iframe_url: SPOTIFY_IFRAME_URL,
        provider_name: "Spotify",
        title: "Deterministic Spotify embed",
      },
    });
  });
});

async function addEmbedIframeBlock(page: Page) {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "/embed");
  await page.getByTestId("slash-menu-item-block-embed-iframe").click();

  const embedIframeBlock = page.locator(EMBED_IFRAME_BLOCK);
  const embedIframeIdleCard = page.locator(IDLE_CARD);
  const embedIframeLinkInputPopup = page.locator(LINK_INPUT_POPUP);
  const input = embedIframeLinkInputPopup.locator("input");

  await expect(embedIframeBlock).toBeVisible();
  await expect(embedIframeIdleCard).toBeVisible();
  await expect(embedIframeLinkInputPopup).toBeVisible();
  await expect(input).toBeFocused();

  return {
    embedIframeBlock,
    embedIframeIdleCard,
    embedIframeLinkInputPopup,
    input,
  };
}

async function createReadyEmbedIframeBlock(page: Page) {
  const {
    embedIframeBlock,
    embedIframeIdleCard,
    embedIframeLinkInputPopup,
    input,
  } = await addEmbedIframeBlock(page);

  await input.fill(SPOTIFY_URL);
  await input.press("Enter");
  await waitNextFrame(page, 200);

  await expect(embedIframeLinkInputPopup).not.toBeVisible();
  await expect(embedIframeIdleCard).not.toBeVisible();
  await expect(embedIframeBlock).toHaveCount(1);
  await expect(embedIframeBlock.locator("iframe")).toHaveAttribute(
    "src",
    SPOTIFY_IFRAME_URL,
  );

  return embedIframeBlock;
}

async function openSwitchViewMenu(page: Page) {
  await page.getByLabel("Switch view").click();
}

test("creates iframe embed from the slash menu and from the idle card", async ({
  page,
}) => {
  const {
    embedIframeBlock,
    embedIframeIdleCard,
    embedIframeLinkInputPopup,
    input,
  } = await addEmbedIframeBlock(page);

  await page.mouse.click(50, 300);
  await waitNextFrame(page, 100);
  await expect(embedIframeLinkInputPopup).not.toBeVisible();

  await embedIframeIdleCard.click();
  await expect(embedIframeLinkInputPopup).toBeVisible();

  await input.fill(SPOTIFY_URL);
  await input.press("Enter");

  await expect(embedIframeLinkInputPopup).not.toBeVisible();
  await expect(embedIframeIdleCard).not.toBeVisible();
  await expect(embedIframeBlock).toHaveCount(1);
});

test("falls back to bookmark when a URL is excluded from iframe embedding", async ({
  page,
}) => {
  const {
    embedIframeBlock,
    embedIframeIdleCard,
    embedIframeLinkInputPopup,
    input,
  } = await addEmbedIframeBlock(page);

  // The generic provider embeds most HTTPS URLs. Use a Myoxus-owned excluded
  // domain so this fallback test tracks the current provider contract.
  await input.fill(NON_EMBEDDABLE_MYOXUS_URL);
  await input.press("Enter");

  await expect(embedIframeLinkInputPopup).not.toBeVisible();
  await expect(embedIframeIdleCard).not.toBeVisible();
  await expect(embedIframeBlock).toHaveCount(0);
  await expect(page.locator("myoxus-bookmark")).toHaveCount(1);
});

test("converts iframe embed between inline, card and embed views", async ({
  page,
}) => {
  let embedIframeBlock = await createReadyEmbedIframeBlock(page);
  await embedIframeBlock.click();

  await openSwitchViewMenu(page);
  await page.getByRole("button", { name: "Inline view" }).click();
  const inlineLink = page.locator("myoxus-link");
  await expect(inlineLink).toBeVisible();
  await expect(embedIframeBlock).toHaveCount(0);

  await inlineLink.hover();
  await openSwitchViewMenu(page);
  await page.getByRole("button", { name: "Embed view" }).click();
  embedIframeBlock = page.locator(EMBED_IFRAME_BLOCK);
  await expect(embedIframeBlock).toHaveCount(1);

  await embedIframeBlock.click();
  await openSwitchViewMenu(page);
  await page.getByRole("button", { name: "Card view" }).click();
  const bookmarkBlock = page.locator("myoxus-bookmark");
  await expect(bookmarkBlock).toHaveCount(1);
  await expect(embedIframeBlock).toHaveCount(0);

  await bookmarkBlock.click();
  await openSwitchViewMenu(page);
  await page.getByRole("button", { name: "Embed view" }).click();
  await expect(page.locator(EMBED_IFRAME_BLOCK)).toHaveCount(1);
  await expect(bookmarkBlock).toHaveCount(0);
});
