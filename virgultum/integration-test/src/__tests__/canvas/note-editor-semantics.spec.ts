// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { LinkExtension } from "@virgultum/editor/inlines/link";
import { textKeymap } from "@virgultum/editor/inlines/preset";
import type {
  ListBlockModel,
  ParagraphBlockModel,
} from "@virgultum/editor/model";
import { insertContent } from "@virgultum/editor/rich-text";
import { REFERENCE_NODE } from "@virgultum/editor/shared/consts";
import { createDefaultDoc } from "@virgultum/editor/shared/utils";
import { TextSelection } from "@virgultum/editor/std";
import type {
  InlineEditor,
  InlineMarkdownMatch,
} from "@virgultum/editor/std/inline";
import { Text } from "@virgultum/editor/store";
import {
  defaultSlashMenuConfig,
  type SlashMenuActionItem,
  type SlashMenuItem,
} from "@virgultum/editor/widgets/slash-menu";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { flushFrame } from "../../harness/pointer.js";
import { insertTestNote, mountTestSession } from "../../harness/session.js";

type RichTextView = HTMLElement & {
  inlineEditor: {
    getFormat: (range: {
      index: number;
      length: number;
    }) => Record<string, unknown>;
    getInlineRange: () => { index: number; length: number } | null;
    setInlineRange: (range: { index: number; length: number }) => void;
    yTextString: string;
  };
  markdownMatches: InlineMarkdownMatch[];
  undoManager: { stopCapturing: () => void };
};

function requireRichText(blockId: string): RichTextView {
  const block = editor.host?.view.getBlock(blockId) as HTMLElement | null;
  if (!block) throw new Error(`Missing block view for ${blockId}`);
  const richText = block.querySelector("rich-text") as RichTextView | null;
  if (!richText) throw new Error(`Missing rich-text element for ${blockId}`);
  return richText;
}

function selectTextRange(blockId: string, index: number, length = 0): void {
  const to = length ? { blockId, index: index + length, length: 0 } : null;
  const sel = editor.host!.selection.create(TextSelection, {
    from: { blockId, index, length: 0 },
    to,
  });
  editor.host!.selection.setGroup("note", [sel]);
  requireRichText(blockId).inlineEditor.setInlineRange({ index, length });
}

async function createNoteParagraph(initialText = "") {
  const noteId = insertTestNote(doc);
  const note = doc.getBlock(noteId)!.model;
  const paragraph = note.children[0] as ParagraphBlockModel;
  if (initialText) {
    doc.updateBlock(paragraph, { text: new Text(initialText) });
  }
  await flushFrame();
  return { noteId, paragraphId: paragraph.id };
}

async function runMarkdownShortcut(
  blockId: string,
  input: string,
  matcherName: string,
): Promise<void> {
  const model = doc.getBlock(blockId)!.model as ParagraphBlockModel;
  doc.updateBlock(model, { text: new Text(input) });
  await flushFrame();

  const richText = requireRichText(blockId);
  const matcher = richText.markdownMatches.find((m) => m.name === matcherName);
  if (!matcher) throw new Error(`Unknown markdown matcher: ${matcherName}`);

  const inlineRange = { index: input.length, length: 0 };
  selectTextRange(blockId, inlineRange.index);
  matcher.action({
    inlineEditor: richText.inlineEditor as never,
    prefixText: input,
    inlineRange,
    pattern: matcher.pattern,
    undoManager: richText.undoManager as never,
  });
  await flushFrame();
}

function findSlashAction(
  items: SlashMenuItem[],
  id: string,
): SlashMenuActionItem {
  const match = items.find((item) => item.id === id);
  if (!match || !("action" in match)) {
    throw new Error(`Missing slash action item: ${id}`);
  }
  return match;
}

describe("Edgeless Note rich-text, keymap, references, and slash-menu semantics", () => {
  beforeEach(async () => {
    return mountTestSession("edgeless", [LinkExtension]);
  });

  test("converts markdown block shortcuts for todo list, heading, quote, and code block", async () => {
    const todo = await createNoteParagraph();
    await runMarkdownShortcut(todo.paragraphId, "[x] ", "list");
    const todoModel = doc.getBlock(todo.noteId)!.model
      .children[0] as ListBlockModel;
    expect(todoModel.flavour).toBe("myoxus:list");
    expect(todoModel.props.type).toBe("todo");
    expect(todoModel.props.checked).toBe(true);

    const heading = await createNoteParagraph();
    await runMarkdownShortcut(heading.paragraphId, "# ", "heading");
    const headingModel = doc.getBlock(heading.noteId)!.model
      .children[0] as ParagraphBlockModel;
    expect(headingModel.props.type).toBe("h1");

    const quote = await createNoteParagraph();
    await runMarkdownShortcut(quote.paragraphId, "> ", "heading");
    const quoteModel = doc.getBlock(quote.noteId)!.model
      .children[0] as ParagraphBlockModel;
    expect(quoteModel.props.type).toBe("quote");

    const code = await createNoteParagraph();
    await runMarkdownShortcut(code.paragraphId, "```ts ", "code-block");
    const codeModel = doc.getBlock(code.noteId)!.model.children[0];
    expect(codeModel.flavour).toBe("myoxus:code");
    expect(
      (codeModel as unknown as { props: { language: string } }).props.language,
    ).toBe("typescript");
    const codeRichText = requireRichText(codeModel.id);
    (codeRichText.inlineEditor as unknown as InlineEditor).insertText(
      { index: 0, length: 0 },
      "value",
      { bold: true },
    );
    expect(
      codeRichText.inlineEditor.getFormat({ index: 0, length: 5 }),
    ).toEqual({ bold: true });
  });

  test("applies inline markdown formatting for bold, code, and links inside a note", async () => {
    const bold = await createNoteParagraph();
    await runMarkdownShortcut(bold.paragraphId, "**bold** ", "bold");
    const boldRt = requireRichText(bold.paragraphId);
    expect(boldRt.inlineEditor.yTextString).toBe("bold");
    expect(
      boldRt.inlineEditor.getFormat({ index: 1, length: 0 }),
    ).toMatchObject({ bold: true });

    const inlineCode = await createNoteParagraph();
    await runMarkdownShortcut(inlineCode.paragraphId, "`code` ", "code");
    const codeRt = requireRichText(inlineCode.paragraphId);
    expect(codeRt.inlineEditor.yTextString).toBe("code");
    expect(
      codeRt.inlineEditor.getFormat({ index: 1, length: 0 }),
    ).toMatchObject({ code: true });

    const link = await createNoteParagraph();
    await runMarkdownShortcut(
      link.paragraphId,
      "[Example](https://example.com) ",
      "link",
    );
    const linkRt = requireRichText(link.paragraphId);
    expect(linkRt.inlineEditor.yTextString).toBe("Example");
    expect(
      linkRt.inlineEditor.getFormat({ index: 1, length: 0 }),
    ).toMatchObject({ link: "https://example.com" });
  });

  test("handles code-block bracket keymap and consecutive myoxus-reference nodes", async () => {
    const code = await createNoteParagraph();
    await runMarkdownShortcut(code.paragraphId, "```ts ", "code-block");
    const codeModel = doc.getBlock(code.noteId)!.model.children[0];

    const keymap = textKeymap(editor.std);
    expect(keymap["("]).toBeDefined();
    expect(keymap[")"]).toBeDefined();

    doc.updateBlock(codeModel, { text: new Text("()") });
    await flushFrame();
    const codeRt = requireRichText(codeModel.id);
    selectTextRange(codeModel.id, 1);

    const preventDefault = vi.fn();
    keymap[")"]!({
      get: (key: string) => {
        if (key === "keyboardState") return { raw: { preventDefault } };
        throw new Error(`Unexpected state key: ${key}`);
      },
    } as never);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(codeRt.inlineEditor.yTextString).toBe("()");

    const refPara = await createNoteParagraph();
    const paraModel = doc.getBlock(refPara.paragraphId)!
      .model as ParagraphBlockModel;
    const targetDoc = createDefaultDoc(collection, { title: "Linked target" });

    selectTextRange(refPara.paragraphId, 0);
    insertContent(editor.std, paraModel, REFERENCE_NODE, {
      reference: { type: "LinkedPage", pageId: targetDoc.id },
    });
    insertContent(editor.std, paraModel, REFERENCE_NODE, {
      reference: { type: "LinkedPage", pageId: targetDoc.id },
    });
    await flushFrame();

    const refRt = requireRichText(refPara.paragraphId);
    expect(refRt.querySelectorAll("myoxus-reference")).toHaveLength(2);
    expect(refRt.inlineEditor.yTextString).toHaveLength(2);
  });

  test("executes defaultSlashMenuConfig move and date actions inside an edgeless note", async () => {
    const noteId = insertTestNote(doc);
    const note = doc.getBlock(noteId)!.model;
    const first = note.children[0] as ParagraphBlockModel;
    const secondId = doc.addBlock(
      "myoxus:paragraph",
      { text: new Text("second") },
      noteId,
    );
    const second = doc.getBlock(secondId)!.model as ParagraphBlockModel;
    doc.updateBlock(first, { text: new Text("first") });
    await flushFrame();

    const items =
      typeof defaultSlashMenuConfig.items === "function"
        ? defaultSlashMenuConfig.items({ std: editor.std, model: first })
        : defaultSlashMenuConfig.items;

    findSlashAction(items, "action-move-down").action({
      std: editor.std,
      model: first,
    });
    await flushFrame();
    expect(note.children.map((c) => c.id)).toEqual([second.id, first.id]);

    findSlashAction(items, "action-move-up").action({
      std: editor.std,
      model: first,
    });
    await flushFrame();
    expect(note.children.map((c) => c.id)).toEqual([first.id, second.id]);

    selectTextRange(first.id, 0);
    findSlashAction(items, "action-today").action({
      std: editor.std,
      model: first,
    });
    await flushFrame();
    expect(requireRichText(first.id).inlineEditor.yTextString).toMatch(
      /\d{4}-\d{2}-\d{2}/,
    );
  });
});
