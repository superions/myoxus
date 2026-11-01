import { expect } from "@playwright/test";

import {
  copyByKeyboard,
  pasteByKeyboard,
  pressArrowLeft,
  pressEnter,
  pressEnterWithShortkey,
  type,
} from "../utils/actions/keyboard.js";
import {
  enterPlaygroundRoom,
  focusRichText,
  getInlineSelectionText,
  getPageSnapshot,
  initEmptyCodeBlockState,
  pasteContent,
  setSelection,
} from "../utils/actions/misc.js";
import {
  assertRichTextInlineRange,
  assertRichTexts,
} from "../utils/asserts.js";
import { test } from "../utils/playwright.js";
import { getCodeBlock } from "./utils.js";

test("keyboard selection and copy paste", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "use");
  await page.keyboard.down("Shift");
  await pressArrowLeft(page, "use".length);
  await page.keyboard.up("Shift");
  await copyByKeyboard(page);
  await pressArrowLeft(page, 1);
  await pasteByKeyboard(page);

  const content = await getInlineSelectionText(page);
  expect(content).toBe("useuse");

  await assertRichTextInlineRange(page, 0, 3, 0);
});

test("pasting plain text replaces selected code text", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "hello world hello");
  await setSelection(page, 2, 6, 2, 11);
  await pasteContent(page, { "text/plain": "test" });

  await assertRichTexts(page, ["hello test hello"]);
});

const codePasteSamples = [
  {
    title: "preserves indentation when pasted with HTML clipboard fallback",
    clipboard: {
      "text/plain": [
        "const fibonacci = (n: number): number => {",
        "  if (n <= 1) return n;",
        "  return fibonacci(n - 1) + fibonacci(n - 2);",
        "}",
      ].join("\n"),
      "text/html":
        "<div>const fibonacci = (n: number): number =&gt; {</div><div>  if (n &lt;= 1) return n;</div><div>  return fibonacci(n - 1) + fibonacci(n - 2);</div><div>}</div>",
    },
    expected: [
      "const fibonacci = (n: number): number => {",
      "  if (n <= 1) return n;",
      "  return fibonacci(n - 1) + fibonacci(n - 2);",
      "}",
    ].join("\n"),
  },
  {
    title: "treats HTML tags from text/plain as literal code text",
    clipboard: {
      "text/plain": "<div><span>const</span><span> value = 1;</span></div>",
    },
    expected: "<div><span>const</span><span> value = 1;</span></div>",
  },
  {
    title: "does not wrap pasted lines in bracket pairs",
    clipboard: {
      "text/plain": [
        '  model: anthropic("claude-sonnet-4-5-20250929"),',
        "  providerOptions: {",
        "    anthropic: {",
        "      thinking: { type: enabled, budgetTokens: 12000 },",
        "    },",
        "  },",
      ].join("\n"),
    },
    expected: [
      '  model: anthropic("claude-sonnet-4-5-20250929"),',
      "  providerOptions: {",
      "    anthropic: {",
      "      thinking: { type: enabled, budgetTokens: 12000 },",
      "    },",
      "  },",
    ].join("\n"),
  },
  {
    title: "treats Markdown syntax as literal code text",
    clipboard: {
      "text/plain": [
        "# Heading 1",
        "",
        "## Heading 2 with **bold** and *italic*",
        "",
        "- Item with `inline code`",
        "```typescript",
        'const code = "block";',
        "```",
        "| Table | Header |",
        "|-------|--------|",
      ].join("\n"),
    },
    expected: [
      "# Heading 1",
      "",
      "## Heading 2 with **bold** and *italic*",
      "",
      "- Item with `inline code`",
      "```typescript",
      'const code = "block";',
      "```",
      "| Table | Header |",
      "|-------|--------|",
    ].join("\n"),
  },
] as const;

for (const sample of codePasteSamples) {
  test(`pasting into code block ${sample.title}`, async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyCodeBlockState(page);
    await focusRichText(page);

    await pasteContent(page, sample.clipboard);

    await assertRichTexts(page, [sample.expected]);
  });
}

test("use keyboard copy inside code block copy", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page);
  await focusRichText(page);

  await type(page, "use");
  await page.keyboard.down("Shift");
  await pressArrowLeft(page, "use".length);
  await page.keyboard.up("Shift");
  await copyByKeyboard(page);
  await page.keyboard.press("ArrowRight");
  await pressEnter(page);
  await pressEnter(page);
  await pasteByKeyboard(page);
  const snapshot = JSON.parse(await getPageSnapshot(page, true));
  expect(snapshot.children[0].children[0].props.text.delta).toEqual([
    { insert: "use\n\nuse" },
  ]);
});

type CodeSnapshotBlock = {
  flavour: string;
  props: {
    language: string | null;
    text: {
      delta: unknown[];
    };
  };
};

async function getCodeBlocksFromSnapshot(
  page: Parameters<typeof getPageSnapshot>[0],
) {
  const snapshot = JSON.parse(await getPageSnapshot(page, true)) as {
    children: Array<{ children: CodeSnapshotBlock[] }>;
  };
  return snapshot.children[0].children.filter(
    (block) => block.flavour === "myoxus:code",
  );
}

test("code block has content, click code block copy menu, copy whole code block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page, { language: "javascript" });
  await focusRichText(page);
  await page.keyboard.type("use");
  await pressEnterWithShortkey(page);

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();

  await expect(codeBlockController.copyButton).toBeVisible();
  await codeBlockController.copyButton.click();

  await focusRichText(page, 1);
  await pasteByKeyboard(page);
  const codeBlocks = await getCodeBlocksFromSnapshot(page);
  expect(codeBlocks).toHaveLength(2);
  expect(codeBlocks.map((block) => block.props.language)).toEqual([
    "javascript",
    "javascript",
  ]);
  expect(codeBlocks.map((block) => block.props.text.delta)).toEqual([
    [{ insert: "use" }],
    [{ insert: "use" }],
  ]);
});

test("code block is empty, click code block copy menu, copy the empty code block", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyCodeBlockState(page, { language: "javascript" });
  await focusRichText(page);

  await pressEnterWithShortkey(page);

  const codeBlockController = getCodeBlock(page);
  await codeBlockController.codeBlock.hover();
  await expect(codeBlockController.copyButton).toBeVisible();
  await codeBlockController.copyButton.click();

  await focusRichText(page, 1);
  await pasteByKeyboard(page);
  const codeBlocks = await getCodeBlocksFromSnapshot(page);
  expect(codeBlocks).toHaveLength(2);
  expect(codeBlocks.map((block) => block.props.language)).toEqual([
    "javascript",
    "javascript",
  ]);
  expect(codeBlocks.map((block) => block.props.text.delta)).toEqual([[], []]);
});
