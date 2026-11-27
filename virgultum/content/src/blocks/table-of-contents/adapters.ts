// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockHtmlAdapterExtension,
  BlockMarkdownAdapterExtension,
  BlockPlainTextAdapterExtension,
} from "@virgultum/core/adapters";
import {
  normalizeTocLevelRange,
  type TableOfContentsProps,
} from "@virgultum/core/models";

const flavour = "myoxus:table-of-contents";
const fromMatch = (o: { node: { flavour: string } }) =>
  o.node.flavour === flavour;

/**
 * Initial WIKI-06 client interchange adapters for `myoxus:table-of-contents`.
 * Preserves authored title/range explicitly without silently omitting the block;
 * full heading-anchor linking across HTML/Markdown/PlainText lands in WIKI-07.
 */
export const tableOfContentsAdapters = [
  BlockHtmlAdapterExtension({
    flavour,
    fromMatch,
    toMatch: () => false,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        const props = o.node.props as Partial<TableOfContentsProps>;
        const { minLevel, maxLevel } = normalizeTocLevelRange(
          props.minLevel,
          props.maxLevel,
        );
        const title =
          typeof props.title === "string" && props.title.trim()
            ? props.title.trim()
            : "Table of contents";
        context.walkerContext
          .openNode(
            {
              type: "element",
              tagName: "nav",
              properties: {
                "data-myoxus-role": "table-of-contents",
                "data-toc-min-level": String(minLevel),
                "data-toc-max-level": String(maxLevel),
              },
              children: [
                {
                  type: "element",
                  tagName: "p",
                  properties: {},
                  children: [{ type: "text", value: title }],
                },
              ],
            },
            "children",
          )
          .closeNode();
        context.walkerContext.skipAllChildren();
      },
    },
  }),
  BlockMarkdownAdapterExtension({
    flavour,
    fromMatch,
    toMatch: () => false,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        const props = o.node.props as Partial<TableOfContentsProps>;
        const title =
          typeof props.title === "string" && props.title.trim()
            ? props.title.trim()
            : "Table of contents";
        context.walkerContext
          .openNode(
            {
              type: "paragraph",
              children: [{ type: "text", value: title }],
            },
            "children",
          )
          .closeNode();
        context.walkerContext.skipAllChildren();
      },
    },
  }),
  BlockPlainTextAdapterExtension({
    flavour,
    fromMatch,
    toMatch: () => false,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        const props = o.node.props as Partial<TableOfContentsProps>;
        const title =
          typeof props.title === "string" && props.title.trim()
            ? props.title.trim()
            : "Table of contents";
        context.textBuffer.content += `${title}\n`;
        context.walkerContext.skipAllChildren();
      },
    },
  }),
];
