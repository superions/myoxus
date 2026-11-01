/**
 * @vitest-environment happy-dom
 */
import type { TextSelection } from "@virgultum/std";
import { describe, expect, it } from "vitest";

import { replaceSelectedTextWithBlocksCommand } from "../../../commands/model-crud/replace-selected-text-with-blocks";
import { myoxus, block } from "../../../test-utils";

describe("commands/model-crud", () => {
  describe("replaceSelectedTextWithBlocksCommand", () => {
    it("should replace selected text with blocks when both first and last blocks are mergable blocks", () => {
      const host = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel<anchor />lo</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2">Wor<focus />ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-paragraph id="111">111</myoxus-paragraph>`,
        block`<myoxus-code id="code"></myoxus-code>`,
        block`<myoxus-paragraph id="222">222</myoxus-paragraph>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel111</myoxus-paragraph>
            <myoxus-code id="code"></myoxus-code>
            <myoxus-paragraph id="paragraph-2">222ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when both first and last blocks are mergable blocks in single paragraph", () => {
      const host = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel<anchor></anchor>lo Wor<focus></focus>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-paragraph id="111">111</myoxus-paragraph>`,
        block`<myoxus-code id="code"></myoxus-code>`,
        block`<myoxus-paragraph id="222">222</myoxus-paragraph>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel111</myoxus-paragraph>
            <myoxus-code id="code"></myoxus-code>
            <myoxus-paragraph id="222">222ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when blocks contains only one mergable block", () => {
      const host = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel<anchor />lo</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2">Wor<focus />ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [block`<myoxus-paragraph id="111">111</myoxus-paragraph>`]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel111ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when blocks contains only one mergable block in single paragraph", () => {
      const host = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel<anchor></anchor>lo Wor<focus></focus>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [block`<myoxus-paragraph id="111">111</myoxus-paragraph>`]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page id="page">
          <myoxus-note id="note">
            <myoxus-paragraph id="paragraph-1">Hel111ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when only first block is mergable block", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor />lo</myoxus-paragraph>
            <myoxus-paragraph>Wor<focus />ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-paragraph>111</myoxus-paragraph>`,
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-code></myoxus-code>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-paragraph>Hel111</myoxus-paragraph>
            <myoxus-code></myoxus-code>
            <myoxus-code></myoxus-code>
            <myoxus-paragraph>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when only first block is mergable block in single paragraph", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor></anchor>lo Wor<focus></focus>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-paragraph>111</myoxus-paragraph>`,
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-code></myoxus-code>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel111</myoxus-paragraph>
            <myoxus-code></myoxus-code>
            <myoxus-code></myoxus-code>
            <myoxus-paragraph>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when only last block is mergable block", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor />lo</myoxus-paragraph>
            <myoxus-paragraph>Wor<focus />ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-paragraph>111</myoxus-paragraph>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-paragraph>Hel</myoxus-paragraph>
            <myoxus-code></myoxus-code>
            <myoxus-code></myoxus-code>
            <myoxus-paragraph>111ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when only last block is mergable block in single paragraph", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor></anchor>lo Wor<focus></focus>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-paragraph>111</myoxus-paragraph>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel</myoxus-paragraph>
            <myoxus-code></myoxus-code>
            <myoxus-code></myoxus-code>
            <myoxus-paragraph>111ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when neither first nor last block is mergable block", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor />lo</myoxus-paragraph>
            <myoxus-paragraph>Wor<focus />ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-code></myoxus-code>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-paragraph>Hel</myoxus-paragraph>
            <myoxus-code></myoxus-code>
            <myoxus-code></myoxus-code>
            <myoxus-paragraph>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when neither first nor last block is mergable block in single paragraph", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor></anchor>lo Wor<focus></focus>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-code></myoxus-code>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel</myoxus-paragraph>
            <myoxus-code></myoxus-code>
            <myoxus-code></myoxus-code>
            <myoxus-paragraph>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when both first and last blocks are mergable blocks with different types", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-paragraph>Hel<anchor />lo</myoxus-paragraph>
            <myoxus-paragraph>Wor<focus />ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-list>1.</myoxus-list>`,
        block`<myoxus-list>2.</myoxus-list>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-paragraph>Hel</myoxus-paragraph>
            <myoxus-list>1.</myoxus-list>
            <myoxus-list>2.</myoxus-list>
            <myoxus-paragraph>ld</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when both first and last blocks are paragraphs, and cursor is at the end of the text-block with different types", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-list>Hel<anchor />lo</myoxus-list>
            <myoxus-list>Wor<focus />ld</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-paragraph>111</myoxus-paragraph>`,
        block`<myoxus-paragraph>222</myoxus-paragraph>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-list>Hel111</myoxus-list>
            <myoxus-list>222ld</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when first block is paragraph, and cursor is at the end of the text-block with different type  ", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-list>Hel<anchor />lo</myoxus-list>
            <myoxus-list>Wor<focus />ld</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-paragraph>111</myoxus-paragraph>`,
        block`<myoxus-code></myoxus-code>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-list>Hel111</myoxus-list>
            <myoxus-code></myoxus-code>
            <myoxus-list>ld</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });

    it("should replace selected text with blocks when last block is paragraph, and cursor is at the end of the text-block with different type  ", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note>
            <myoxus-list>Hel<anchor />lo</myoxus-list>
            <myoxus-list>Wor<focus />ld</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;

      const blocks = [
        block`<myoxus-code></myoxus-code>`,
        block`<myoxus-paragraph>222</myoxus-paragraph>`,
      ]
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .map((b) => b.model);

      const textSelection = host.selection.value[0] as TextSelection;

      host.command.exec(replaceSelectedTextWithBlocksCommand, {
        textSelection,
        blocks,
      });

      const expected = myoxus`
        <myoxus-page>
          <myoxus-note >
            <myoxus-list>Hel</myoxus-list>
            <myoxus-code></myoxus-code>
            <myoxus-list>222ld</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;
      expect(host.store).toEqualDoc(expected.store);
    });
  });
});
