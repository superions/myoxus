import "./utils/declare-test-window.js";

import { expect, type Page } from "@playwright/test";
import type { BookmarkBlockComponent } from "@virgultum/editor/blocks/bookmark";
import type { BlockSnapshot } from "@virgultum/store";

import {
  activeNoteInEdgeless,
  clickView,
  copyByKeyboard,
  createNote,
  edgelessCommonSetup,
  enterPlaygroundRoom,
  focusRichText,
  getPageSnapshot,
  initEmptyEdgelessState,
  initEmptyParagraphState,
  pasteByKeyboard,
  pasteContent,
  pressArrowRight,
  pressArrowUp,
  pressBackspace,
  pressEnter,
  pressShiftTab,
  pressTab,
  setEdgelessTool,
  setInlineRangeInSelectedRichText,
  SHORT_KEY,
  switchEditorMode,
  type,
  waitForInlineEditorStateUpdated,
  waitNextFrame,
} from "./utils/actions/index.js";
import {
  assertBlockChildrenFlavours,
  assertBlockChildrenIds,
  assertBlockCount,
  assertBlockFlavour,
  assertBlockSelections,
} from "./utils/asserts.js";
import { scoped, test } from "./utils/playwright.js";
import { getEmbedCardToolbar } from "./utils/query.js";

const LOCAL_HOST_URL = "http://localhost";

const YOUTUBE_URL = "https://www.youtube.com/watch?v=fakeid";

const FIGMA_URL = "https://www.figma.com/design/JuXs6uOAICwf4I4tps0xKZ123";

test("cancelling card creation preserves the source paragraph and typing focus", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await type(page, "/git");
  await page
    .getByRole("option", { name: "Git Issues & Pull Requests", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("myoxus-paragraph")).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .locator("myoxus-paragraph")
        .evaluate((element) =>
          element.contains(
            element.ownerDocument.getSelection()?.anchorNode ?? null,
          ),
        ),
    )
    .toBe(true);
  await type(page, "Continue editing");
  await expect(page.locator("myoxus-paragraph")).toContainText(
    "Continue editing",
  );
});

type BookmarkSnapshotBlock = BlockSnapshot & {
  props: {
    url: string;
  };
};

type ParagraphSnapshotBlock = BlockSnapshot & {
  props: {
    text: {
      delta: unknown[];
    };
  };
};

async function getFirstChildBlockIdByFlavour(
  page: Page,
  parentId: string,
  flavour: string,
) {
  const blockId = await page.evaluate(
    ({ flavour, parentId }) => {
      const parent = window.doc?.getBlock(parentId)?.model;
      return parent?.children.find((child) => child.flavour === flavour)?.id;
    },
    { flavour, parentId },
  );

  if (!blockId) {
    throw new Error(`Child block ${flavour} under ${parentId} was not found`);
  }

  return blockId;
}

async function ensurePageMode(page: Page) {
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLElement & { mode: "page" | "edgeless" }>(
        "myoxus-editor-container",
      )
      .forEach((container) => {
        container.mode = "page";
        container.removeAttribute("style");
      });
  });
  await page.locator("myoxus-page-root").waitFor({ state: "visible" });
  await waitNextFrame(page);
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/worker/link-preview", async (route) => {
    await route.fulfill({
      json: {
        url: route.request().postDataJSON()?.url ?? "",
      },
    });
  });

  // Embed blocks query provider APIs in addition to the server-side preview
  // endpoint. Mock those requests so bookmark E2E coverage is deterministic and
  // never depends on public YouTube/GitHub availability or local Vite fallbacks.
  await page.route("https://youtube.com/oembed**", async (route) => {
    await route.fulfill({
      json: {},
    });
  });
  await page.route("https://api.github.com/repos/**", async (route) => {
    await route.fulfill({
      json: {
        assignees: [],
        created_at: null,
        draft: false,
        merged: false,
        state: null,
        state_reason: null,
      },
    });
  });
  for (const url of [
    "https://www.youtube.com/embed/**",
    "https://www.figma.com/embed?**",
  ]) {
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Provider fixture</title>",
      }),
    );
  }
});

const createBookmarkBlockBySlashMenu = async (
  page: Page,
  url = LOCAL_HOST_URL,
) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await page.waitForTimeout(100);
  await type(page, "/link", 100);
  await pressEnter(page);
  await page.waitForTimeout(100);
  await type(page, url);
  await pressEnter(page);
};

async function assertBookmark(page: Page, url = LOCAL_HOST_URL) {
  const bookmark = page.locator("myoxus-bookmark");
  await expect(bookmark).toHaveCount(1);
  await expect(bookmark).toBeVisible();
  expect(
    await bookmark.evaluate((el: BookmarkBlockComponent) => ({
      url: el.model.props.url,
      parent: el.model.parent?.flavour,
    })),
  ).toEqual({ url, parent: "myoxus:note" });
}

test(scoped`create bookmark by slash menu`, async ({ page }) => {
  await createBookmarkBlockBySlashMenu(page);
  await assertBookmark(page);
});

test(scoped`covert bookmark block to link text`, async ({ page }) => {
  await createBookmarkBlockBySlashMenu(page);
  const bookmark = page.locator("myoxus-bookmark");
  await bookmark.click();
  await page.waitForTimeout(100);
  await page.getByRole("combobox", { name: "Switch view" }).click();
  await page.getByRole("option", { name: "Inline view" }).click();
  await expect(bookmark).toHaveCount(0);
  await expect(page.locator("myoxus-paragraph myoxus-link a")).toHaveAttribute(
    "href",
    LOCAL_HOST_URL,
  );
  await expect(page.locator("myoxus-paragraph myoxus-link a")).toHaveText(
    LOCAL_HOST_URL,
  );
});

test(scoped`copy url to create bookmark in page mode`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, LOCAL_HOST_URL);
  await setInlineRangeInSelectedRichText(page, 0, LOCAL_HOST_URL.length);
  await copyByKeyboard(page);
  await focusRichText(page);
  await type(page, "/link");
  await pressEnter(page);
  await page.keyboard.press(`${SHORT_KEY}+v`);
  await pressEnter(page);
  await assertBookmark(page);
});

test(scoped`copy url to create bookmark in edgeless mode`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  const ids = await initEmptyEdgelessState(page);
  await focusRichText(page);
  await type(page, LOCAL_HOST_URL);

  await switchEditorMode(page);

  await setEdgelessTool(page, { type: "default" });
  await activeNoteInEdgeless(page, ids.noteId);
  await waitForInlineEditorStateUpdated(page);
  await focusRichText(page);
  await setInlineRangeInSelectedRichText(page, 0, LOCAL_HOST_URL.length);
  await copyByKeyboard(page);
  await pressArrowRight(page);
  await pressEnter(page);
  await type(page, "/link", 100);
  await pressEnter(page);
  await page.waitForTimeout(100);
  await waitNextFrame(page);
  await page.keyboard.press(`${SHORT_KEY}+v`);
  await pressEnter(page);
  await assertBookmark(page);
});

test("press backspace after bookmark block can select bookmark block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await ensurePageMode(page);
  await focusRichText(page);

  await pressEnter(page);
  await pressArrowUp(page);
  await type(page, "/link");
  await pressEnter(page);
  await page.waitForTimeout(100);
  await type(page, LOCAL_HOST_URL);
  await pressEnter(page);

  await focusRichText(page);
  await assertBlockCount(page, "paragraph", 1);
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const editorHost = document.querySelector("editor-host");
        const richText = editorHost?.querySelector("rich-text");
        const range = richText?.inlineEditor?.getInlineRange();
        return range?.length === 0 && [0, 1].includes(range.index);
      });
    })
    .toBe(true);
  await waitNextFrame(page);
  await pressBackspace(page);
  await assertBlockSelections(page, ["4"]);
  await assertBlockCount(page, "paragraph", 0);
});

test.describe("embed card toolbar", () => {
  async function showEmbedCardToolbar(page: Page) {
    await createBookmarkBlockBySlashMenu(page);
    const bookmark = page.locator("myoxus-bookmark");
    await bookmark.click();
    await page.waitForTimeout(100);
    const { embedCardToolbar } = getEmbedCardToolbar(page);
    await expect(embedCardToolbar).toBeVisible();
  }

  test("copy bookmark url by copy button", async ({ page }) => {
    await showEmbedCardToolbar(page);
    const { copyButton } = getEmbedCardToolbar(page);
    await copyButton.click();
    await page.mouse.click(600, 600);
    await waitNextFrame(page);

    await pasteByKeyboard(page);
    const snapshot = JSON.parse(
      await getPageSnapshot(page, true),
    ) as BlockSnapshot;
    const note = snapshot.children[0] as BlockSnapshot;
    const [bookmark, pastedParagraph] = note.children as [
      BookmarkSnapshotBlock,
      ParagraphSnapshotBlock,
    ];

    expect(bookmark.flavour).toBe("myoxus:bookmark");
    expect(bookmark.props.url).toBe(LOCAL_HOST_URL);
    expect(pastedParagraph.flavour).toBe("myoxus:paragraph");
    expect(pastedParagraph.props.text.delta).toEqual([
      {
        attributes: {
          link: LOCAL_HOST_URL,
        },
        insert: LOCAL_HOST_URL,
      },
    ]);
  });

  test("change card style", async ({ page }) => {
    await showEmbedCardToolbar(page);
    const bookmark = page.locator("myoxus-bookmark");
    const { openCardStyleMenu } = getEmbedCardToolbar(page);
    await openCardStyleMenu();
    const { cardStyleHorizontalButton, cardStyleListButton } =
      getEmbedCardToolbar(page);
    await cardStyleListButton.click();
    await waitNextFrame(page);
    const listStyleBookmarkBox = await bookmark.boundingBox();
    if (!listStyleBookmarkBox) {
      throw new Error("listStyleBookmarkBox is not found");
    }
    await expect
      .poll(() =>
        bookmark.evaluate((el: BookmarkBlockComponent) => el.model.props.style),
      )
      .toBe("list");

    await openCardStyleMenu();
    await cardStyleHorizontalButton.click();
    await waitNextFrame(page);
    const horizontalStyleBookmarkBox = await bookmark.boundingBox();
    if (!horizontalStyleBookmarkBox) {
      throw new Error("horizontalStyleBookmarkBox is not found");
    }
    expect(horizontalStyleBookmarkBox.height).toBeGreaterThan(
      listStyleBookmarkBox.height,
    );
    await expect
      .poll(() =>
        bookmark.evaluate((el: BookmarkBlockComponent) => el.model.props.style),
      )
      .toBe("horizontal");
  });
});

test("indent bookmark block to paragraph", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await pressEnter(page);
  await type(page, "/link", 100);
  await pressEnter(page);
  await type(page, LOCAL_HOST_URL);
  await pressEnter(page);

  const bookmarkId = await getFirstChildBlockIdByFlavour(
    page,
    "1",
    "myoxus:bookmark",
  );
  await assertBlockChildrenIds(page, "1", ["2", bookmarkId]);
  await assertBlockChildrenFlavours(page, "1", [
    "myoxus:paragraph",
    "myoxus:bookmark",
  ]);
  await assertBlockFlavour(page, "1", "myoxus:note");
  await assertBlockFlavour(page, "2", "myoxus:paragraph");
  await assertBlockFlavour(page, bookmarkId, "myoxus:bookmark");

  await page
    .locator(`myoxus-bookmark[data-block-id="${bookmarkId}"]`)
    .evaluate((el: BookmarkBlockComponent) => {
      el.selectBlock();
      getSelection()?.removeAllRanges();
    });
  await assertBlockSelections(page, [bookmarkId]);
  await page.locator("editor-host").focus();
  await pressTab(page);
  await assertBlockChildrenIds(page, "1", ["2"]);
  await assertBlockChildrenIds(page, "2", [bookmarkId]);

  await pressShiftTab(page);
  await assertBlockChildrenIds(page, "1", ["2", bookmarkId]);
});

test("indent bookmark block to list", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);

  await focusRichText(page);
  await type(page, "- a");
  await pressEnter(page);
  await type(page, "/link", 100);
  await pressEnter(page);
  await type(page, LOCAL_HOST_URL);
  await pressEnter(page);

  const bookmarkId = await getFirstChildBlockIdByFlavour(
    page,
    "1",
    "myoxus:bookmark",
  );

  await assertBlockChildrenIds(page, "1", ["3", bookmarkId]);
  await assertBlockFlavour(page, "1", "myoxus:note");
  await assertBlockFlavour(page, "3", "myoxus:list");
  await assertBlockFlavour(page, bookmarkId, "myoxus:bookmark");

  await page
    .locator(`myoxus-bookmark[data-block-id="${bookmarkId}"]`)
    .evaluate((el: BookmarkBlockComponent) => {
      el.selectBlock();
      getSelection()?.removeAllRanges();
    });
  await assertBlockSelections(page, [bookmarkId]);
  await page.locator("editor-host").focus();
  await pressTab(page);
  await assertBlockChildrenIds(page, "1", ["3"]);
  await assertBlockChildrenIds(page, "3", [bookmarkId]);

  await pressShiftTab(page);
  await assertBlockChildrenIds(page, "1", ["3", bookmarkId]);
});

test("bookmark card should show banner in edgeless mode", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyEdgelessState(page);
  await switchEditorMode(page);

  const url = "https://github.com/example/project/pull/11796";

  await page.locator("edgeless-link-tool-button").click();
  await page.getByRole("dialog").getByRole("textbox").fill(url);
  await pressEnter(page);

  const banner = page.locator(".myoxus-bookmark-banner");
  await expect(banner).toBeVisible();
});

for (const { provider, url, iframe } of [
  {
    provider: "youtube",
    url: YOUTUBE_URL,
    iframe: "https://www.youtube.com/embed/fakeid",
  },
  {
    provider: "figma",
    url: FIGMA_URL,
    iframe: `https://www.figma.com/embed?embed_host=virgultum&url=${FIGMA_URL}`,
  },
]) {
  test(`${provider} creation and Card/Embed round trip preserve the URL`, async ({
    page,
  }) => {
    await createBookmarkBlockBySlashMenu(page, url);
    const embed = page.locator(`myoxus-embed-${provider}-block`);
    await expect(embed).toBeVisible();
    await expect(embed.locator("iframe")).toHaveAttribute("src", iframe);
    const parent = await embed.evaluate(
      (el: BookmarkBlockComponent) => el.model.parent?.id,
    );
    await embed.click();
    await page
      .getByRole("combobox", { name: "Switch view", exact: true })
      .click();
    await page.getByRole("option", { name: "Card view", exact: true }).click();
    await expect(embed).toHaveCount(0);
    await assertBookmark(page, url);
    const bookmark = page.locator("myoxus-bookmark");
    expect(
      await bookmark.evaluate(
        (el: BookmarkBlockComponent) => el.model.parent?.id,
      ),
    ).toBe(parent);
    await bookmark.click();
    await page
      .getByRole("combobox", { name: "Switch view", exact: true })
      .click();
    await page.getByRole("option", { name: "Embed view", exact: true }).click();
    await expect(bookmark).toHaveCount(0);
    await expect(embed).toBeVisible();
    await expect(embed.locator("iframe")).toHaveAttribute("src", iframe);
    expect(
      await embed.evaluate((el: BookmarkBlockComponent) => ({
        url: el.model.props.url,
        parent: el.model.parent?.id,
      })),
    ).toEqual({ url, parent });
  });
}

test.describe("embed github card", () => {
  test("github embed card should show banner in edgeless mode", async ({
    page,
  }) => {
    await enterPlaygroundRoom(page);
    await initEmptyEdgelessState(page);
    await switchEditorMode(page);
    await clickView(page, [0, 0]);
    const url = "https://github.com/example/project/pull/11796";

    await pasteContent(page, {
      "text/plain": url,
    });

    const banner = page.locator(".myoxus-embed-github-banner");
    await expect(banner).toBeVisible();
  });
});

test("drag a card from canvas to note should not change the style of the card", async ({
  page,
}) => {
  const url = "https://github.com/example/project/pull/12660";

  await edgelessCommonSetup(page);
  await createNote(page, [0, 200]);
  const targetNote = page.locator("myoxus-edgeless-note").last();
  await expect(targetNote).toBeVisible();
  await page.locator("edgeless-link-tool-button").click();
  await page.getByRole("dialog").getByRole("textbox").fill(url);
  await pressEnter(page);

  const edgelessBookmark = page.locator("myoxus-edgeless-bookmark");
  await edgelessBookmark.click();
  await waitNextFrame(page);
  await page.dragAndDrop(
    ".myoxus-drag-handle-grabber.dots",
    "myoxus-edgeless-note",
  );

  const noteBookmark = page.locator("myoxus-bookmark");
  await expect(noteBookmark).toBeVisible();
  const style = await noteBookmark.evaluate(
    (el: BookmarkBlockComponent) => el.model.props.style,
  );
  expect(style).toBe("horizontal");
});
