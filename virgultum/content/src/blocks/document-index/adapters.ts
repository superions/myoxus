// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Element, ElementContent } from "hast";
import type { DocumentIndexProps } from "@virgultum/core/models";
import {
  BlockHtmlAdapterExtension,
  BlockMarkdownAdapterExtension,
  BlockPlainTextAdapterExtension,
} from "@virgultum/core/adapters";
import { DocumentIndexOutputProvider } from "@virgultum/core/services/data";
const flavour = "myoxus:document-index";
const fromMatch = (o: { node: { flavour: string } }) =>
  o.node.flavour === flavour;
export const documentIndexAdapters = [
  BlockHtmlAdapterExtension({
    flavour,
    fromMatch,
    toMatch: () => false,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: async (o, context) => {
        const provider = (context.scopeProvider ?? context.provider)?.get(
          DocumentIndexOutputProvider,
        );
        if (!provider) throw new Error("Directory output provider unavailable");
        const props = o.node.props as DocumentIndexProps;
        if (props.view === "table") {
          const table = await provider.resolveTable(
            props,
            props.workspaceId ??
              (context.walkerContext.getGlobalContext(
                "document-index-workspace",
              ) as string | undefined),
          );
          const text = (value: string) => ({ type: "text" as const, value });
          const element = (
            tagName: string,
            children: ElementContent[],
            properties: Element["properties"] = {},
          ): Element => ({
            type: "element" as const,
            tagName,
            properties,
            children,
          });
          context.walkerContext
            .openNode(
              element("section", [
                ...(props.title ? [element("h2", [text(props.title)])] : []),
                element("table", [
                  element("thead", [
                    element(
                      "tr",
                      table.headers.map((value) =>
                        element("th", [text(value)], { scope: "col" }),
                      ),
                    ),
                  ]),
                  element(
                    "tbody",
                    table.rows.map((row) =>
                      element(
                        "tr",
                        row.map((cell) =>
                          element("td", [
                            cell.href
                              ? element("a", [text(cell.text)], {
                                  href: cell.href,
                                })
                              : text(cell.text),
                          ]),
                        ),
                      ),
                    ),
                  ),
                ]),
              ]),
              "children",
            )
            .closeNode();
          context.walkerContext.skipAllChildren();
          return;
        }
        const rows = await provider.resolve(
          props.query,
          props.workspaceId !== undefined
            ? props.workspaceId
            : (context.walkerContext.getGlobalContext(
                "document-index-workspace",
              ) as string | undefined),
        );
        context.walkerContext
          .openNode(
            {
              type: "element",
              tagName: "section",
              properties: {},
              children: [
                ...(props.title
                  ? [
                      {
                        type: "element" as const,
                        tagName: "h2",
                        properties: {},
                        children: [
                          { type: "text" as const, value: props.title },
                        ],
                      },
                    ]
                  : []),
                {
                  type: "element",
                  tagName: "ul",
                  properties: {},
                  children: rows.length
                    ? rows.map((row) => ({
                        type: "element",
                        tagName: "li",
                        properties: {},
                        children: [
                          {
                            type: "element",
                            tagName: "a",
                            properties: { href: row.href },
                            children: [{ type: "text", value: row.title }],
                          },
                        ],
                      }))
                    : [
                        {
                          type: "element",
                          tagName: "li",
                          properties: {},
                          children: [
                            { type: "text", value: provider.emptyText },
                          ],
                        },
                      ],
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
      enter: async (o, context) => {
        const provider = (context.scopeProvider ?? context.provider)?.get(
          DocumentIndexOutputProvider,
        );
        if (!provider) throw new Error("Directory output provider unavailable");
        const props = o.node.props as DocumentIndexProps;
        if (props.view === "table") {
          const table = await provider.resolveTable(
            props,
            props.workspaceId ??
              (context.walkerContext.getGlobalContext(
                "document-index-workspace",
              ) as string | undefined),
          );
          if (context.markdownImportDiagnostics)
            context.markdownImportDiagnostics.unsupportedReferences += 1;
          if (props.title)
            context.walkerContext
              .openNode(
                {
                  type: "heading",
                  depth: 2,
                  children: [{ type: "text", value: props.title }],
                },
                "children",
              )
              .closeNode();
          const rows = [
            table.headers.map((text) => ({
              text,
              href: undefined as string | undefined,
            })),
            ...table.rows,
          ];
          context.walkerContext
            .openNode(
              {
                type: "table",
                align: table.headers.map(() => null),
                children: rows.map((row) => ({
                  type: "tableRow",
                  children: row.map((cell) => ({
                    type: "tableCell",
                    children: cell.href
                      ? [
                          {
                            type: "link",
                            url: cell.href,
                            children: [{ type: "text", value: cell.text }],
                          },
                        ]
                      : [{ type: "text", value: cell.text }],
                  })),
                })),
              },
              "children",
            )
            .closeNode();
          context.walkerContext.skipAllChildren();
          return;
        }
        const rows = await provider.resolve(
          props.query,
          props.workspaceId !== undefined
            ? props.workspaceId
            : (context.walkerContext.getGlobalContext(
                "document-index-workspace",
              ) as string | undefined),
        );
        const diagnostics = context.markdownImportDiagnostics;
        if (diagnostics) diagnostics.unsupportedReferences += 1;
        if (props.title) {
          context.walkerContext
            .openNode(
              {
                type: "heading",
                depth: 2,
                children: [{ type: "text", value: props.title }],
              },
              "children",
            )
            .closeNode();
        }
        context.walkerContext
          .openNode(
            {
              type: "list",
              ordered: false,
              spread: false,
              children: (rows.length
                ? rows
                : [{ title: provider.emptyText, href: "" }]
              ).map((row) => ({
                type: "listItem",
                spread: false,
                children: [
                  {
                    type: "paragraph",
                    children: row.href
                      ? [
                          {
                            type: "link",
                            url: row.href,
                            children: [{ type: "text", value: row.title }],
                          },
                        ]
                      : [{ type: "text", value: row.title }],
                  },
                ],
              })),
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
      enter: async (o, context) => {
        const provider = (context.scopeProvider ?? context.provider)?.get(
          DocumentIndexOutputProvider,
        );
        if (!provider) throw new Error("Directory output provider unavailable");
        const props = o.node.props as DocumentIndexProps;
        if (props.view === "table") {
          const table = await provider.resolveTable(
            props,
            props.workspaceId ??
              (context.walkerContext.getGlobalContext(
                "document-index-workspace",
              ) as string | undefined),
          );
          context.textBuffer.content +=
            [
              props.title,
              table.headers.join("\t"),
              ...table.rows.map((row) =>
                row.map((cell) => cell.text).join("\t"),
              ),
            ]
              .filter(Boolean)
              .join("\n") + "\n";
          return;
        }
        const rows = await provider.resolve(
          props.query,
          props.workspaceId !== undefined
            ? props.workspaceId
            : (context.walkerContext.getGlobalContext(
                "document-index-workspace",
              ) as string | undefined),
        );
        context.textBuffer.content +=
          [
            props.title,
            ...(rows.length
              ? rows.map((row) => `${row.title} (${row.href})`)
              : [provider.emptyText]),
          ]
            .filter(Boolean)
            .join("\n") + "\n";
      },
    },
  }),
];
