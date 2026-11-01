import "./utils/declare-test-window.js";

import {
  enterPlaygroundRoom,
  initEmptyCodeBlockState,
} from "./utils/actions/index.js";
import { assertBlockChildrenIds, assertBlockFlavour } from "./utils/asserts.js";
import { scoped, test } from "./utils/playwright.js";

const bookMarkUrl = "http://localhost";
const embedUrl = "https://github.com/example/virgultum/pull/7217";

test.beforeEach(async ({ page }) => {
  await page.route("/api/worker/link-preview", async (route) => {
    await route.fulfill({
      json: {},
    });
  });
});

test(
  scoped`create a paragraph-block while clicking zero-width of code-block which is the last block of page`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyCodeBlockState(page);
    const codeComponent = page.locator("myoxus-code");
    const rect = await codeComponent.boundingBox();
    if (!rect) {
      throw new Error("code-block not found");
    }
    // click the zero width
    await page.mouse.click(rect.x + 20, rect.y + rect.height + 8);
    await assertBlockFlavour(page, "3", "myoxus:paragraph");
  },
);

test(
  scoped`don't create a paragraph-block while clicking zero-width of code-block before a paragraph-block`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await page.evaluate(() => {
      const { doc } = window;
      const rootId =
        doc.root?.id ??
        doc.addBlock("myoxus:page", {
          title: new window.$virgultum.store.Text(),
        });
      const note = doc.addBlock("myoxus:note", {}, rootId);
      doc.addBlock("myoxus:code", {}, note);
      doc.addBlock("myoxus:paragraph", {}, note);
    });
    const codeComponent = page.locator("myoxus-code");
    const codeComponentrect = await codeComponent.boundingBox();
    if (!codeComponentrect) {
      throw new Error("code-block not found");
    }
    await page.mouse.click(
      codeComponentrect.x + 20,
      codeComponentrect.y + codeComponentrect.height + 8,
    );
    await assertBlockChildrenIds(page, "1", ["2", "3"]);
  },
);

test(
  scoped`create a paragraph-block while clicking between two non-paragraph-block`,
  async ({ page }) => {
    await enterPlaygroundRoom(page);
    await page.evaluate(
      async ({ bookMarkUrl, embedUrl }) => {
        const { doc } = window;
        const rootId =
          doc.root?.id ??
          doc.addBlock("myoxus:page", {
            title: new window.$virgultum.store.Text(),
          });
        const note = doc.addBlock("myoxus:note", {}, rootId);
        doc.addBlock("myoxus:code", {}, note);
        doc.addBlock("myoxus:divider", {}, note);
        doc.addBlock("myoxus:bookmark", { url: bookMarkUrl }, note);
        await new Promise((res) => setTimeout(res, 200));
        const pageRoot = document.querySelector("myoxus-page-root");
        if (!pageRoot) throw new Error("Cannot find doc page");
        const imageBlob = await fetch(
          `${location.origin}/test-card-1.png`,
        ).then((response) => response.blob());
        const storage = doc.blobSync;
        const sourceId = await storage.set(imageBlob);
        doc.addBlock("myoxus:image", { sourceId }, note);
        doc.addBlock("myoxus:embed-github", { url: embedUrl }, note);
      },
      { bookMarkUrl, embedUrl },
    );
    const codeComponent = page.locator("myoxus-code");
    const codeComponentrect = await codeComponent.boundingBox();
    if (!codeComponentrect) {
      throw new Error("code-block not found");
    }
    await page.mouse.click(
      codeComponentrect.x + 20,
      codeComponentrect.y + codeComponentrect.height + 8,
    );
    await assertBlockFlavour(page, "7", "myoxus:paragraph");

    const dividerComponent = page.locator("myoxus-divider");
    const dividerComponentRect = await dividerComponent.boundingBox();
    if (!dividerComponentRect) {
      throw new Error("divider-block not found");
    }
    await page.mouse.click(
      dividerComponentRect.x + 20,
      dividerComponentRect.y + dividerComponentRect.height + 8,
    );
    await assertBlockFlavour(page, "8", "myoxus:paragraph");

    const bookmarkComponent = page.locator("myoxus-bookmark");
    const bookmarkComponentRect = await bookmarkComponent.boundingBox();
    if (!bookmarkComponentRect) {
      throw new Error("bookmark-block not found");
    }
    await page.mouse.click(
      bookmarkComponentRect.x + 20,
      bookmarkComponentRect.y + bookmarkComponentRect.height + 8,
    );
    await assertBlockFlavour(page, "9", "myoxus:paragraph");

    await page.evaluate(() => {
      const viewport = document.querySelector(".myoxus-page-viewport");
      if (!viewport) {
        throw new Error();
      }
      viewport.scrollTo(0, 600);
    });

    const imageComponent = page.locator("myoxus-image");
    const imageComponentRect = await imageComponent.boundingBox();
    if (!imageComponentRect) {
      throw new Error("image-block not found");
    }
    await page.mouse.click(
      imageComponentRect.x + 20,
      imageComponentRect.y + imageComponentRect.height + 8,
    );
    await assertBlockFlavour(page, "10", "myoxus:paragraph");
  },
);
