// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMarkdownPreview,
  type MarkdownPreviewNode,
} from "@virgultum/editor/shared/adapters";
import { createElement, Fragment, type ReactNode, useMemo } from "react";
import { Checkbox } from "@myoxus/ui-facade";

function safeHref(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** File content is React text/semantic markup, never executable HTML or an automatic remote image fetch. */
export function MarkdownPreview({ source }: { source: string }) {
  return useMemo(() => {
    const root = parseMarkdownPreview(source);
    const definitions = new Map(
      root.children
        .filter((node) => node.type === "definition")
        .map((node) => [node.identifier, node]),
    );
    const render = (node: MarkdownPreviewNode, index = 0): ReactNode => {
      const children =
        "children" in node
          ? node.children.map((child, i) => render(child, i))
          : undefined;
      const element = (tag: string, props = {}) =>
        createElement(tag, { key: index, ...props }, children);
      switch (node.type) {
        case "root":
          return <Fragment key={index}>{children}</Fragment>;
        case "text":
          return node.value;
        case "paragraph":
          return element("p");
        case "heading":
          return element(`h${node.depth}`);
        case "strong":
          return element("strong");
        case "emphasis":
          return element("em");
        case "delete":
          return element("del");
        case "inlineCode":
          return <code key={index}>{node.value}</code>;
        case "code":
          return (
            <pre key={index}>
              <code>{node.value}</code>
            </pre>
          );
        case "break":
          return <br key={index} />;
        case "thematicBreak":
          return <hr key={index} />;
        case "blockquote":
          return element("blockquote");
        case "list":
          return element(node.ordered ? "ol" : "ul", {
            ...(node.ordered ? { start: node.start ?? 1 } : {}),
            // Editor resets remove browser markers; these belong to authored Markdown.
            style: {
              listStyleType: node.ordered
                ? "decimal"
                : node.children.some((item) => item.checked != null)
                  ? "none"
                  : "disc",
            },
          });
        case "listItem": {
          const content = node.children.map((child, i) =>
            child.type === "paragraph" && !node.spread ? (
              <Fragment key={i}>
                {child.children.map((value, j) => render(value, j))}
              </Fragment>
            ) : (
              render(child, i)
            ),
          );
          return (
            <li key={index}>
              {node.checked != null ? (
                <Checkbox checked={node.checked} disabled label={content} />
              ) : (
                content
              )}
            </li>
          );
        }
        case "link": {
          const href = safeHref(node.url);
          return href ? (
            element("a", {
              href,
              title: node.title ?? undefined,
              target: "_blank",
              rel: "noopener noreferrer",
            })
          ) : (
            <Fragment key={index}>{children}</Fragment>
          );
        }
        case "linkReference": {
          const href = safeHref(definitions.get(node.identifier)?.url ?? "");
          return href ? (
            element("a", { href, target: "_blank", rel: "noopener noreferrer" })
          ) : (
            <Fragment key={index}>{children}</Fragment>
          );
        }
        case "image":
          return <span key={index}>{node.alt || node.url}</span>;
        case "table": {
          const row = (
            row: (typeof node.children)[number],
            index: number,
            header = false,
          ) => (
            <tr key={index}>
              {row.children.map((cell, column) =>
                createElement(
                  header ? "th" : "td",
                  // Column alignment is authored file content, not card chrome.
                  {
                    key: column,
                    style: node.align?.[column]
                      ? { textAlign: node.align[column] }
                      : undefined,
                  },
                  cell.children.map((child, i) => render(child, i)),
                ),
              )}
            </tr>
          );
          return (
            <table key={index}>
              <thead>
                {node.children
                  .slice(0, 1)
                  .map((value, i) => row(value, i, true))}
              </thead>
              <tbody>
                {node.children.slice(1).map((value, i) => row(value, i))}
              </tbody>
            </table>
          );
        }
        case "tableRow":
          return element("tr");
        case "tableCell":
          return element("td");
        case "definition":
          return null;
        default: {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          return (
            <span key={index}>
              {start !== undefined && end !== undefined
                ? source.slice(start, end)
                : "value" in node
                  ? String(node.value)
                  : children}
            </span>
          );
        }
      }
    };
    return render(root);
  }, [source]);
}
