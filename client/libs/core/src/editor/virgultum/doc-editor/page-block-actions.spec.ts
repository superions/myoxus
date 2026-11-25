// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import {
  BookmarkBlockSchemaExtension,
  EmbedYoutubeBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  type BookmarkBlockModel,
  type ParagraphBlockModel,
} from "@virgultum/core/models";
import { Text } from "@virgultum/core/store";
import { TestWorkspace } from "@virgultum/core/store/test";
import { describe, expect, test } from "vitest";

import {
  convertCardBlockToInlineLink,
  convertLinkToEmbedCard,
  deletePageBlock,
  duplicatePageBlock,
  embedFlavourForUrl,
  pasteAfterPageBlock,
} from "./page-block-actions";

function createStore() {
  const workspace = new TestWorkspace({ id: "page-block-actions-spec" });
  workspace.meta.initialize();
  const doc = workspace.createDoc("doc-1");
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      BookmarkBlockSchemaExtension,
      EmbedYoutubeBlockSchemaExtension,
    ],
  });
  const rootId = store.addBlock("myoxus:page", {});
  const noteId = store.addBlock("myoxus:note", {}, rootId);
  const paraId = store.addBlock(
    "myoxus:paragraph",
    {
      text: new Text([
        {
          insert: "Example",
          attributes: { link: "https://example.com" },
        },
      ]),
    },
    noteId,
  );
  store.resetHistory();
  return {
    store,
    note: store.getModelById(noteId)!,
    para: store.getModelById(paraId) as ParagraphBlockModel,
  };
}

describe("page-block-actions (SPE-02)", () => {
  test("resolves embed flavours from URLs", () => {
    expect(
      embedFlavourForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe("myoxus:embed-youtube");
    expect(embedFlavourForUrl("https://example.com/article")).toBe(
      "myoxus:bookmark",
    );
  });

  test("converts inline link to bookmark card and back with single-step undo", () => {
    const { store, note, para } = createStore();
    const cardId = convertLinkToEmbedCard(
      store,
      para,
      0,
      7,
      "https://example.com",
    );
    expect(cardId).toBeTruthy();
    const card = store.getModelById(cardId!) as BookmarkBlockModel;
    expect(card.flavour).toBe("myoxus:bookmark");
    expect(card.props.url).toBe("https://example.com");
    expect(note.children).toHaveLength(1);

    const dupId = duplicatePageBlock(card);
    expect(dupId).toBeTruthy();
    expect(note.children).toHaveLength(2);
    expect(deletePageBlock(store.getModelById(dupId!)!)).toBe(true);
    expect(note.children).toHaveLength(1);

    const paraId = convertCardBlockToInlineLink(
      card,
      card.props.url,
      "Myoxus Link",
    );
    expect(paraId).toBeTruthy();
    const restored = store.getModelById(paraId!) as ParagraphBlockModel;
    expect(restored.text?.toString()).toBe("Myoxus Link");

    store.undo();
    expect(note.children[0]?.flavour).toBe("myoxus:bookmark");
  });

  test("pastes plain URL and text lines after an atomic block directly on Store", async () => {
    const { store, note, para } = createStore();
    const cardId = convertLinkToEmbedCard(
      store,
      para,
      0,
      7,
      "https://example.com",
    )!;
    const card = store.getModelById(cardId)!;
    const dt = {
      files: [],
      getData: (type: string) =>
        type === "text/plain" ? "First line\nSecond line" : "",
    } as unknown as DataTransfer;

    expect(await pasteAfterPageBlock(card, dt)).toBe(true);
    expect(note.children).toHaveLength(3);
    expect(note.children[1]?.text?.toString()).toBe("First line");
    expect(note.children[2]?.text?.toString()).toBe("Second line");
  });
});
