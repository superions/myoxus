import {
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
  pasteContent,
  pressArrowDown,
  pressArrowUp,
  pressEscape,
  waitEmbedLoaded,
} from "../utils/actions/index.js";
import { assertRichImage, assertText } from "../utils/asserts.js";
import { scoped, test } from "../utils/playwright.js";

test(
  scoped`clipboard paste end with image, the cursor should be controlled by up/down keys`,
  async ({ page }) => {
    test.info().annotations.push({
      type: "issue",
      description: "https://github.com/example/virgultum/issues/3639",
    });
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);

    // Use the renderer's own asset; a third-party image host is not this gate.
    const imageUrl = new URL("/test-card-1.png", page.url()).href;
    const clipData = {
      "text/html": `<p>Lorem Ipsum placeholder text.</p>
    <figure ><img src='${imageUrl}' /></figure>
    `,
    };
    await pasteContent(page, clipData);
    const str = "Lorem Ipsum placeholder text.";
    await waitEmbedLoaded(page);
    await assertRichImage(page, 1);
    await pressEscape(page);
    await pressArrowUp(page, 1);
    await pasteContent(page, clipData);
    await assertRichImage(page, 2);
    await assertText(page, str + str);
    await pressArrowDown(page, 1);
    await pressEscape(page);
    await pasteContent(page, clipData);
    await assertRichImage(page, 3);
    await assertText(page, "Lorem Ipsum placeholder text.", 1);
  },
);
