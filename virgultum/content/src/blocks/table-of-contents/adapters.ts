// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockHtmlAdapterExtension,
  BlockMarkdownAdapterExtension,
  BlockPlainTextAdapterExtension,
  type HtmlAST,
} from "@virgultum/core/adapters";
import {
  normalizeTocLevelRange,
  type TableOfContentsProps,
} from "@virgultum/core/models";
import type { BlockSnapshot, NodeProps } from "@virgultum/core/store";
import {
  collectSnapshotTocEntries,
  type SnapshotTocEntry,
} from "@virgultum/core/utils";

const flavour = "myoxus:table-of-contents";
const fromMatch = (o: { node: { flavour: string } }) =>
  o.node.flavour === flavour;

function resolveRootSnapshot(o: NodeProps<BlockSnapshot>): BlockSnapshot {
  let root: NodeProps<BlockSnapshot> = o;
  while (root.parent) {
    root = root.parent;
  }
  return root.node;
}

function getTocProjection(o: NodeProps<BlockSnapshot>): {
  title: string;
  minLevel: number;
  maxLevel: number;
  entries: SnapshotTocEntry[];
} {
  const props = o.node.props as Partial<TableOfContentsProps>;
  const { minLevel, maxLevel } = normalizeTocLevelRange(
    props.minLevel,
    props.maxLevel,
  );
  const title =
    typeof props.title === "string" && props.title.trim()
      ? props.title.trim()
      : "Table of contents";
  const entries = collectSnapshotTocEntries(resolveRootSnapshot(o), {
    minLevel,
    maxLevel,
  });
  return { title, minLevel, maxLevel, entries };
}

/**
 * Client HTML, Markdown, and PlainText interchange adapters for `myoxus:table-of-contents`.
 * Emits deterministic heading links matching `paragraph/adapters/html.ts` and server `public_render`.
 */
export const tableOfContentsAdapters = [
  BlockHtmlAdapterExtension({
    flavour,
    fromMatch,
    toMatch: () => false,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        const { title, minLevel, maxLevel, entries } = getTocProjection(o);
        const baseLevel =
          entries.length > 0
            ? Math.min(...entries.map((entry) => entry.level))
            : minLevel;
        const navChildren: Array<Extract<HtmlAST, { type: "element" }>> = [
          {
            type: "element",
            tagName: "p",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "strong",
                properties: {},
                children: [{ type: "text", value: title }],
              },
            ],
          },
        ];
        if (entries.length > 0) {
          navChildren.push({
            type: "element",
            tagName: "ul",
            properties: {},
            children: entries.map((entry) => ({
              type: "element",
              tagName: "li",
              properties: {
                "data-toc-level": String(entry.level),
                "data-toc-depth": String(Math.max(0, entry.level - baseLevel)),
              },
              children: [
                {
                  type: "element",
                  tagName: "a",
                  properties: { href: `#${entry.slug}` },
                  children: [{ type: "text", value: entry.label }],
                },
              ],
            })),
          });
        }
        context.walkerContext
          .openNode(
            {
              type: "element",
              tagName: "nav",
              properties: {
                "data-myoxus-role": "table-of-contents",
                "data-toc-min-level": String(minLevel),
                "data-toc-max-level": String(maxLevel),
                "aria-label": title,
              },
              children: navChildren,
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
        const { title, entries } = getTocProjection(o);
        context.walkerContext
          .openNode(
            {
              type: "paragraph",
              children: [
                {
                  type: "strong",
                  children: [{ type: "text", value: title }],
                },
              ],
            },
            "children",
          )
          .closeNode();
        if (entries.length > 0) {
          context.walkerContext
            .openNode(
              {
                type: "list",
                ordered: false,
                spread: false,
                children: entries.map((entry) => ({
                  type: "listItem",
                  spread: false,
                  children: [
                    {
                      type: "paragraph",
                      children: [
                        {
                          type: "link",
                          url: `#${entry.slug}`,
                          children: [{ type: "text", value: entry.label }],
                        },
                      ],
                    },
                  ],
                })),
              },
              "children",
            )
            .closeNode();
        }
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
        const { title, entries } = getTocProjection(o);
        const baseLevel =
          entries.length > 0
            ? Math.min(...entries.map((entry) => entry.level))
            : 1;
        context.textBuffer.content += `${title}\n`;
        for (const entry of entries) {
          const indent = "  ".repeat(Math.max(0, entry.level - baseLevel));
          context.textBuffer.content += `${indent}- ${entry.label}\n`;
        }
        context.walkerContext.skipAllChildren();
      },
    },
  }),
];
