import {
  enterPlaygroundRoom,
  focusRichText,
  initEmptyParagraphState,
  pasteContent,
  resetHistory,
  undoByKeyboard,
  waitNextFrame,
} from "../utils/actions/index.js";
import {
  assertBlockTypes,
  assertRichTexts,
  assertTextFormats,
} from "../utils/asserts.js";
import { scoped, test } from "../utils/playwright.js";

test(scoped`markdown format parse`, async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await resetHistory(page);

  let clipData = {
    "text/plain": `# h1

## h2

### h3

#### h4

##### h5

###### h6

- [ ] todo

- [ ] todo

- [x] todo

* bulleted

- bulleted

1. numbered

> quote
`,
  };
  await waitNextFrame(page);
  await pasteContent(page, clipData);
  await page.waitForTimeout(200);
  await assertBlockTypes(page, [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "todo",
    "todo",
    "todo",
    "bulleted",
    "bulleted",
    "numbered",
    "quote",
  ]);
  await assertRichTexts(page, [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "todo",
    "todo",
    "todo",
    "bulleted",
    "bulleted",
    "numbered",
    "quote",
  ]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);
  await focusRichText(page);

  clipData = {
    "text/plain": `# ***bolditalic***
# **bold**

*italic*

~~strikethrough~~

[link](linktest)

\`code\`
`,
  };
  await waitNextFrame(page);
  await pasteContent(page, clipData);
  await page.waitForTimeout(200);
  await assertTextFormats(page, [
    { bold: true, italic: true },
    { bold: true },
    { italic: true },
    { strike: true },
    { link: "linktest" },
    { code: true },
  ]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);
});
