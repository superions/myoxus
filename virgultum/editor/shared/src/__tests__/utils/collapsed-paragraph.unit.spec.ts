import {
  NoteBlockSchemaExtension,
  type ParagraphBlockModel,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/model";
import { type Store, Text } from "@virgultum/store";
import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from "@virgultum/store/test";
import { describe, expect, it } from "vitest";

import {
  calculateCollapsedSiblings,
  getNearestHeadingBefore,
} from "../../utils/collapsed/paragraph.js";

const extensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
];

function createTestDoc() {
  const collection = new TestWorkspace({
    id: "collapsed-paragraph-test",
    idGenerator: createAutoIncrementIdGenerator(),
  });
  collection.meta.initialize();
  const doc = collection.createDoc("doc:collapsed-paragraph");
  doc.load();
  return doc.getStore({ extensions });
}

function createParagraphSet(
  doc: Store,
  parent: string,
  blocks: Array<{ type: string; label: string }>,
) {
  return blocks.map(({ type, label }) =>
    doc.addBlock(
      "myoxus:paragraph",
      {
        type,
        text: new Text(label),
      },
      parent,
    ),
  );
}

function getParagraph(doc: Store, id: string) {
  return doc.getModelById(id) as ParagraphBlockModel;
}

describe("collapsed paragraph utilities", () => {
  it("cuts collapsed siblings at the next heading with the same or higher level", () => {
    const doc = createTestDoc();
    const root = doc.addBlock("myoxus:page", {});
    const note = doc.addBlock("myoxus:note", {}, root);
    const [h1A, textB, h2C, textD, h3E, textF, h2G, textH, h1I, textJ] =
      createParagraphSet(doc, note, [
        { type: "h1", label: "aaa" },
        { type: "text", label: "bbb" },
        { type: "h2", label: "ccc" },
        { type: "text", label: "ddd" },
        { type: "h3", label: "eee" },
        { type: "text", label: "fff" },
        { type: "h2", label: "ggg" },
        { type: "text", label: "hhh" },
        { type: "h1", label: "iii" },
        { type: "text", label: "jjj" },
      ]);

    expect(
      calculateCollapsedSiblings(getParagraph(doc, h1A)).map(({ id }) => id),
    ).toEqual([textB, h2C, textD, h3E, textF, h2G, textH]);
    expect(
      calculateCollapsedSiblings(getParagraph(doc, h2C)).map(({ id }) => id),
    ).toEqual([textD, h3E, textF]);
    expect(
      calculateCollapsedSiblings(getParagraph(doc, h3E)).map(({ id }) => id),
    ).toEqual([textF]);
    expect(
      calculateCollapsedSiblings(getParagraph(doc, h2G)).map(({ id }) => id),
    ).toEqual([textH]);
    expect(
      calculateCollapsedSiblings(getParagraph(doc, h1I)).map(({ id }) => id),
    ).toEqual([textJ]);
  });

  it("finds the nearest heading before a paragraph within its current parent", () => {
    const doc = createTestDoc();
    const root = doc.addBlock("myoxus:page", {});
    const note = doc.addBlock("myoxus:note", {}, root);
    const [h1A, textB, h2C, textD] = createParagraphSet(doc, note, [
      { type: "h1", label: "aaa" },
      { type: "text", label: "bbb" },
      { type: "h2", label: "ccc" },
      { type: "text", label: "ddd" },
    ]);

    expect(getNearestHeadingBefore(getParagraph(doc, textB))?.id).toBe(h1A);
    expect(getNearestHeadingBefore(getParagraph(doc, textD))?.id).toBe(h2C);
    expect(getNearestHeadingBefore(getParagraph(doc, h1A))).toBeNull();
  });
});
