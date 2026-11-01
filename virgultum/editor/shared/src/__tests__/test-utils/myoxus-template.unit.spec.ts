import { TextSelection } from "@virgultum/std";
import { describe, expect, it } from "vitest";

import { myoxus } from "../../test-utils";

describe("helpers/myoxus-template", () => {
  it("should create a basic document structure from template", () => {
    const host = myoxus`
      <myoxus-page id="page">
        <myoxus-note id="note">
          <myoxus-paragraph id="paragraph-1">Hello, world</myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    expect(host.store).toBeDefined();

    const pageBlock = host.store.getBlock("page");
    expect(pageBlock).toBeDefined();
    expect(pageBlock?.flavour).toBe("myoxus:page");

    const noteBlock = host.store.getBlock("note");
    expect(noteBlock).toBeDefined();
    expect(noteBlock?.flavour).toBe("myoxus:note");

    const paragraphBlock = host.store.getBlock("paragraph-1");
    expect(paragraphBlock).toBeDefined();
    expect(paragraphBlock?.flavour).toBe("myoxus:paragraph");
  });

  it("should handle nested blocks correctly", () => {
    const host = myoxus`
      <myoxus-page>
        <myoxus-note>
          <myoxus-paragraph>First paragraph</myoxus-paragraph>
          <myoxus-list>List item</myoxus-list>
          <myoxus-paragraph>Second paragraph</myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    const noteBlocks = host.store.getBlocksByFlavour("myoxus:note");
    const paragraphBlocks = host.store.getBlocksByFlavour("myoxus:paragraph");
    const listBlocks = host.store.getBlocksByFlavour("myoxus:list");

    expect(noteBlocks.length).toBe(1);
    expect(paragraphBlocks.length).toBe(2);
    expect(listBlocks.length).toBe(1);

    const noteBlock = noteBlocks[0];
    const noteChildren =
      host.store.getBlock(noteBlock.id)?.model.children || [];
    expect(noteChildren.length).toBe(3);

    expect(noteChildren[0].flavour).toBe("myoxus:paragraph");
    expect(noteChildren[1].flavour).toBe("myoxus:list");
    expect(noteChildren[2].flavour).toBe("myoxus:paragraph");
  });

  it("should handle empty blocks correctly", () => {
    const host = myoxus`
      <myoxus-page>
        <myoxus-note>
          <myoxus-paragraph></myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    const paragraphBlocks = host.store.getBlocksByFlavour("myoxus:paragraph");
    expect(paragraphBlocks.length).toBe(1);

    const paragraphBlock = host.store.getBlock(paragraphBlocks[0].id);
    const paragraphText = paragraphBlock?.model.text?.toString() || "";
    expect(paragraphText).toBe("");
  });

  it("should throw error on invalid template", () => {
    expect(() => {
      myoxus`
        <unknown-tag></unknown-tag>
      `;
    }).toThrow();
  });

  it("should handle text selection with anchor and focus", () => {
    const host = myoxus`
      <myoxus-page id="page">
        <myoxus-note id="note">
          <myoxus-paragraph id="paragraph-1">Hel<anchor />lo</myoxus-paragraph>
          <myoxus-paragraph id="paragraph-2">Wo<focus />rld</myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    const selection = host.selection.value[0] as TextSelection;
    expect(selection).toBeDefined();
    expect(selection.is(TextSelection)).toBe(true);
    expect(selection.from.blockId).toBe("paragraph-1");
    expect(selection.from.index).toBe(3);
    expect(selection.from.length).toBe(2);
    expect(selection.to?.blockId).toBe("paragraph-2");
    expect(selection.to?.index).toBe(0);
    expect(selection.to?.length).toBe(2);
  });

  it("should handle cursor position", () => {
    const host = myoxus`
      <myoxus-page id="page">
        <myoxus-note id="note">
          <myoxus-paragraph id="paragraph-1">Hello<cursor />World</myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    const selection = host.selection.value[0] as TextSelection;
    expect(selection).toBeDefined();
    expect(selection.is(TextSelection)).toBe(true);
    expect(selection.from.blockId).toBe("paragraph-1");
    expect(selection.from.index).toBe(5);
    expect(selection.from.length).toBe(0);
    expect(selection.to).toBeNull();
  });

  it("should handle selection in empty blocks", () => {
    const host = myoxus`
      <myoxus-page id="page">
        <myoxus-note id="note">
          <myoxus-paragraph id="paragraph-1"><cursor /></myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    const selection = host.selection.value[0] as TextSelection;
    expect(selection).toBeDefined();
    expect(selection.is(TextSelection)).toBe(true);
    expect(selection.from.blockId).toBe("paragraph-1");
    expect(selection.from.index).toBe(0);
    expect(selection.from.length).toBe(0);
    expect(selection.to).toBeNull();
  });

  it("should handle single point selection", () => {
    const host = myoxus`
      <myoxus-page id="page">
        <myoxus-note id="note">
          <myoxus-paragraph id="paragraph-1">Hello<anchor></anchor>World<focus></focus>Affine</myoxus-paragraph>
        </myoxus-note>
      </myoxus-page>
    `;

    const selection = host.selection.value[0] as TextSelection;
    expect(selection).toBeDefined();
    expect(selection.is(TextSelection)).toBe(true);
    expect(selection.from.blockId).toBe("paragraph-1");
    expect(selection.from.index).toBe(5);
    expect(selection.from.length).toBe(5);
    expect(selection.to).toBeNull();
  });
});
