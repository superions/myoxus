// SPDX-License-Identifier: AGPL-3.0-or-later
import { FootNoteSchema } from "@virgultum/model";
import {
  HastUtils,
  HtmlASTToDeltaExtension,
  InlineDeltaToHtmlAdapterExtension,
  LOCAL_FOOTNOTE_HTML_PREFIX,
} from "@virgultum/shared/adapters";

export const localFootnoteDeltaToHtml = InlineDeltaToHtmlAdapterExtension({
  name: "local-footnote",
  match: (delta) => delta.attributes?.footnote?.definitionId !== undefined,
  toAST: (delta) => {
    const footnote = FootNoteSchema.parse(delta.attributes?.footnote);
    if (footnote.definitionId === undefined)
      throw new Error("Expected a local footnote");
    const marker = (): import("hast").Element => ({
      type: "element",
      tagName: "sup",
      properties: {
        dataMyoxusFootnoteDefinitionId: footnote.definitionId,
        dataMyoxusFootnoteLabel: footnote.label,
      },
      children: [
        {
          type: "element",
          tagName: "a",
          properties: {
            href: `#myoxus-footnote-${footnote.definitionId}`,
            role: "doc-noteref",
            ariaLabel: footnote.label,
          },
          children: [{ type: "text", value: footnote.label }],
        },
      ],
    });
    // Adjacent atomic embeds can share one Yjs delta; each retains its own
    // navigation anchor and survives HTML clipboard reimport individually.
    return delta.insert.length === 1
      ? marker()
      : {
          type: "element",
          tagName: "span",
          properties: {},
          children: Array.from(delta.insert, marker),
        };
  },
});

export const localFootnoteHtmlToDelta = HtmlASTToDeltaExtension({
  name: "local-footnote",
  match: (node) =>
    HastUtils.isElement(node) &&
    node.tagName === "sup" &&
    node.properties.dataMyoxusFootnoteDefinitionId !== undefined,
  toDelta: (node, { configs }) => {
    if (!HastUtils.isElement(node)) return [];
    const value = configs.get(
      LOCAL_FOOTNOTE_HTML_PREFIX +
        node.properties.dataMyoxusFootnoteDefinitionId,
    );
    if (!value) throw new Error("Unresolved HTML footnote reference");
    return [
      {
        insert: " ",
        attributes: { footnote: FootNoteSchema.parse(JSON.parse(value)) },
      },
    ];
  },
});
