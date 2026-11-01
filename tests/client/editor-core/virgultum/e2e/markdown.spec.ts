import { expect } from "@playwright/test";
import type { BlockSnapshot } from "@virgultum/store";

import {
  enterPlaygroundRoom,
  focusRichText,
  getCursorBlockIdAndHeight,
  getPageSnapshot,
  initEmptyParagraphState,
  pasteContent,
  pressArrowLeft,
  pressArrowRight,
  pressBackspace,
  pressEnter,
  pressSpace,
  redoByKeyboard,
  resetHistory,
  switchReadonly,
  type,
  undoByKeyboard,
  waitNextFrame,
} from "./utils/actions/index.js";
import {
  assertBlockTextContent,
  assertBlockType,
  assertRichTextInlineDeltas,
  assertRichTextInlineRange,
  assertRichTexts,
  assertText,
} from "./utils/asserts.js";
import { test } from "./utils/playwright.js";

test("quote hard breaks survive history and readonly mode", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "> ");
  const [id] = await getCursorBlockIdAndHeight(page);
  await type(page, "First line");
  await page.keyboard.press("Shift+Enter");
  await type(page, "Second line");

  await assertBlockType(page, id, "quote");
  await assertBlockTextContent(page, id, "First line\nSecond line");

  await resetHistory(page);
  await type(page, "!");
  await undoByKeyboard(page);
  await assertBlockTextContent(page, id, "First line\nSecond line");
  await redoByKeyboard(page);
  await assertBlockTextContent(page, id, "First line\nSecond line!");
  await undoByKeyboard(page);

  await switchReadonly(page);
  const readonlySnapshot = await getPageSnapshot(page, true);
  await focusRichText(page);
  await type(page, "must not persist");
  expect(await getPageSnapshot(page, true)).toBe(readonlySnapshot);
  await assertBlockType(page, id, "quote");
  await assertBlockTextContent(page, id, "First line\nSecond line");
});

test("markdown quote import preserves its native child hierarchy", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await resetHistory(page);

  await pasteContent(page, {
    "text/plain": `Prelude first\\
continued

> First line\\
> second line
>
> Continuation
>
> > Nested quote
>
> 7. Seventh
>    - [ ] Pending task
>
> \`\`\`ts
> const value = 1;
> \`\`\`
>
> | Column | Detail |
> | --- | ---: |
> | one<br>two | value |
`,
  });
  await waitNextFrame(page);

  const quoteSemantics = async () => {
    const root = (await getPageSnapshot(page)) as BlockSnapshot;
    const note = root.children.find((block) => block.flavour === "myoxus:note");
    const quote = note?.children.find(
      (block) =>
        block.flavour === "myoxus:paragraph" &&
        block.props.type === "quote" &&
        block.children.length > 0,
    );
    const paragraph = note?.children.find(
      (block) =>
        block.flavour === "myoxus:paragraph" &&
        block.props.type === "text" &&
        (block.props.text as { delta?: Array<{ insert?: string }> }).delta
          ?.map((part) => part.insert ?? "")
          .join("")
          .startsWith("Prelude"),
    );
    return {
      paragraphText: (
        paragraph?.props.text as
          { delta?: Array<{ insert?: string }> } | undefined
      )?.delta
        ?.map((part) => part.insert ?? "")
        .join(""),
      quoteTexts: note?.children
        .filter(
          (block) =>
            block.flavour === "myoxus:paragraph" &&
            block.props.type === "quote",
        )
        .map((block) =>
          (
            block.props.text as {
              delta?: Array<{ insert?: string }>;
            }
          ).delta
            ?.map((part) => part.insert ?? "")
            .join(""),
        ),
      text: (
        quote?.props.text as { delta?: Array<{ insert?: string }> } | undefined
      )?.delta
        ?.map((part) => part.insert ?? "")
        .join(""),
      children: quote?.children.map((block) => ({
        flavour: block.flavour,
        type: block.props.type,
        order: block.props.order,
        checked: block.props.checked,
        children: block.children.map((child) => ({
          flavour: child.flavour,
          type: child.props.type,
          checked: child.props.checked,
        })),
      })),
    };
  };

  const expected = {
    paragraphText: "Prelude first\ncontinued",
    quoteTexts: ["First line\nsecond line"],
    text: "First line\nsecond line",
    children: [
      {
        flavour: "myoxus:paragraph",
        type: "text",
        order: undefined,
        checked: undefined,
        children: [],
      },
      {
        flavour: "myoxus:paragraph",
        type: "quote",
        order: undefined,
        checked: undefined,
        children: [],
      },
      {
        flavour: "myoxus:list",
        type: "numbered",
        order: 7,
        checked: false,
        children: [
          {
            flavour: "myoxus:list",
            type: "todo",
            checked: false,
          },
        ],
      },
      {
        flavour: "myoxus:code",
        type: undefined,
        order: undefined,
        checked: undefined,
        children: [],
      },
      {
        flavour: "myoxus:table",
        type: undefined,
        order: undefined,
        checked: undefined,
        children: [],
      },
    ],
  };
  expect(await quoteSemantics()).toEqual(expected);
  await undoByKeyboard(page);
  expect((await quoteSemantics()).children).toBeUndefined();
  await redoByKeyboard(page);
  expect(await quoteSemantics()).toEqual(expected);
});

test("plain-text paste distinguishes soft wraps and explicit breaks", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await pasteContent(page, {
    "text/plain": "soft\nwrap\n\nbackslash\\\nbreak\n\ntwo spaces  \nbreak",
  });
  await waitNextFrame(page);

  await assertRichTexts(page, [
    "soft wrap",
    "backslash\nbreak",
    "two spaces\nbreak",
  ]);
  await undoByKeyboard(page);
  await redoByKeyboard(page);
  await assertRichTexts(page, [
    "soft wrap",
    "backslash\nbreak",
    "two spaces\nbreak",
  ]);
  await switchReadonly(page);
  await assertRichTexts(page, [
    "soft wrap",
    "backslash\nbreak",
    "two spaces\nbreak",
  ]);
});

test("markdown shortcut", async ({ page }) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);
  await resetHistory(page);

  let id: string | null = null;

  await waitNextFrame(page);
  await type(page, "[] ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "todo");
  await undoByKeyboard(page);
  await assertText(page, "[] ");
  await undoByKeyboard(page);
  //FIXME: it just failed in playwright
  await focusRichText(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "[ ] ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "todo");
  await undoByKeyboard(page);
  await assertText(page, "[ ] ");
  await undoByKeyboard(page);
  //FIXME: it just failed in playwright
  await focusRichText(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "[x] ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "todo");
  await undoByKeyboard(page);
  await assertText(page, "[x] ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "* ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "bulleted");
  await undoByKeyboard(page);
  await assertText(page, "* ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "- ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "bulleted");
  await undoByKeyboard(page);
  await assertText(page, "- ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "1. ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "numbered");
  await undoByKeyboard(page);
  await assertText(page, "1. ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "20. ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "numbered");
  await undoByKeyboard(page);
  await assertText(page, "20. ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "# ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "h1");
  await undoByKeyboard(page);
  await assertText(page, "# ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "## ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "h2");
  await undoByKeyboard(page);
  await assertText(page, "## ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "### ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "h3");
  await undoByKeyboard(page);
  await assertText(page, "### ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "#### ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "h4");
  await undoByKeyboard(page);
  await assertText(page, "#### ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "##### ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "h5");
  await undoByKeyboard(page);
  await assertText(page, "##### ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "###### ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "h6");
  await undoByKeyboard(page);
  await assertText(page, "###### ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "> ");
  await waitNextFrame(page);
  [id] = await getCursorBlockIdAndHeight(page);
  await assertBlockType(page, id, "quote");
  await undoByKeyboard(page);
  await assertText(page, "> ");
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  // testing various horizontal dividers
  await waitNextFrame(page);
  await type(page, "--- ");
  await undoByKeyboard(page);
  await assertRichTexts(page, ["--- "]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "*** ");
  await undoByKeyboard(page);
  await assertRichTexts(page, ["*** "]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "___ ");
  await undoByKeyboard(page);
  await assertRichTexts(page, ["___ "]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "------ ");
  await undoByKeyboard(page);
  await assertRichTexts(page, ["------ "]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "****** ");
  await undoByKeyboard(page);
  await assertRichTexts(page, ["****** "]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);

  await waitNextFrame(page);
  await type(page, "______ ");
  await undoByKeyboard(page);
  await assertRichTexts(page, ["______ "]);
  await undoByKeyboard(page);
  await assertRichTexts(page, [""]);
});

test.describe("markdown inline-text", () => {
  test.beforeEach(async ({ page }) => {
    await enterPlaygroundRoom(page);
    await initEmptyParagraphState(page);
    await focusRichText(page);
    await resetHistory(page);
  });

  test("bolditalic", async ({ page }) => {
    await type(page, "aa***b*** ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "b",
        attributes: {
          bold: true,
          italic: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await type(page, "aa***bb*** ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          bold: true,
          italic: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await assertRichTextInlineRange(page, 0, 11);
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa***bb*** ",
      },
    ]);
    await redoByKeyboard(page);
    await type(page, "cc");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bbcc",
        attributes: {
          bold: true,
          italic: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "***test *** ");
    await assertRichTexts(page, ["***test *** "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    // *** + space will be converted to divider, so needn't test this case here
    // await waitNextFrame(page);
    // await type(page, '*** test*** ');
    // await assertRichTexts(page, ['*** test*** ']);
    // await undoByKeyboard(page);
    // await assertRichTexts(page, ['']);
  });

  test("bold", async ({ page }) => {
    await type(page, "aa**b** ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "b",
        attributes: {
          bold: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await type(page, "aa**bb** ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          bold: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await assertRichTextInlineRange(page, 0, 9);
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa**bb** ",
      },
    ]);
    await redoByKeyboard(page);
    await type(page, "cc");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bbcc",
        attributes: {
          bold: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "**test ** ");
    await assertRichTexts(page, ["**test ** "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "** test** ");
    await assertRichTexts(page, ["** test** "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);
  });

  test("italic", async ({ page }) => {
    await type(page, "aa*b* ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "b",
        attributes: {
          italic: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await type(page, "aa*bb* ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          italic: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await assertRichTextInlineRange(page, 0, 7);
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa*bb* ",
      },
    ]);
    await redoByKeyboard(page);
    await type(page, "cc");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bbcc",
        attributes: {
          italic: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "*test * ");
    await assertRichTexts(page, ["*test * "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    // * + space will be converted to bulleted list, so needn't test this case here
    // await waitNextFrame(page);
    // await type(page, '* test* ');
    // await assertRichTexts(page, ['* test* ']);
    // await undoByKeyboard(page);
    // await assertRichTexts(page, ['']);
  });

  test("strike", async ({ page }) => {
    await type(page, "aa~~b~~ ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "b",
        attributes: {
          strike: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await type(page, "aa~~bb~~ ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          strike: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await assertRichTextInlineRange(page, 0, 9);
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa~~bb~~ ",
      },
    ]);
    await redoByKeyboard(page);
    await type(page, "cc");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bbcc",
        attributes: {
          strike: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "~~test ~~ ");
    await assertRichTexts(page, ["~~test ~~ "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "~~ test~~ ");
    await assertRichTexts(page, ["~~ test~~ "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);
  });

  test("underline", async ({ page }) => {
    await type(page, "aa~b~ ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "b",
        attributes: {
          underline: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await type(page, "aa~bb~ ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          underline: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await assertRichTextInlineRange(page, 0, 7);
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa~bb~ ",
      },
    ]);
    await redoByKeyboard(page);
    await type(page, "cc");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bbcc",
        attributes: {
          underline: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "~test ~ ");
    await assertRichTexts(page, ["~test ~ "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "~ test~ ");
    await assertRichTexts(page, ["~ test~ "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);
  });

  test("code", async ({ page }) => {
    await type(page, "aa`b` ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "b",
        attributes: {
          code: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await type(page, "aa`bb` ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          code: true,
        },
      },
    ]);
    await undoByKeyboard(page);
    await assertRichTextInlineRange(page, 0, 7);
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa`bb` ",
      },
    ]);
    await redoByKeyboard(page);
    await type(page, "cc");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "aa",
      },
      {
        insert: "bb",
        attributes: {
          code: true,
        },
      },
      {
        insert: "cc",
      },
    ]);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "`test ` ");
    await assertRichTexts(page, ["`test ` "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    await waitNextFrame(page);
    await type(page, "` test` ");
    await assertRichTexts(page, ["` test` "]);
    await undoByKeyboard(page);
    await assertRichTexts(page, [""]);

    // https://github.com/example/project/issues/9410
    await waitNextFrame(page);
    await type(page, "test**bold** ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "test",
      },
      {
        insert: "bold",
        attributes: {
          bold: true,
        },
      },
    ]);
    await pressArrowLeft(page, 8);
    await type(page, "`");
    await pressArrowRight(page, 8);
    await type(page, "` ");
    await assertRichTextInlineDeltas(page, [
      {
        insert: "test",
        attributes: {
          code: true,
        },
      },
      {
        insert: "bold",
        attributes: {
          bold: true,
          code: true,
        },
      },
    ]);
  });
});

test("inline code should work when pressing Enter followed by Backspace twice", async ({
  page,
}) => {
  await enterPlaygroundRoom(page);
  await initEmptyParagraphState(page);
  await focusRichText(page);

  await type(page, "`test`");
  await pressSpace(page);
  await waitNextFrame(page);
  await pressArrowLeft(page);
  await waitNextFrame(page);
  await pressEnter(page);
  await waitNextFrame(page);
  await pressBackspace(page);
  await waitNextFrame(page);
  await pressEnter(page);
  await waitNextFrame(page);
  await pressBackspace(page);

  await assertRichTexts(page, ["test"]);
});
