// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMarkdownPreview,
  citationDefinition,
  type MarkdownAST,
  type MarkdownPreviewNode,
  type WikiLinkData,
} from "@virgultum/editor/shared/adapters";
import { createElement, Fragment, type ReactNode, useMemo } from "react";
import type { CitationFootNote } from "@virgultum/core/models";
import { MyoxusText, Checkbox } from "@myoxus/ui-facade";

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

export interface MarkdownPreviewPresentation {
  heading(
    depth: 1 | 2 | 3 | 4 | 5 | 6,
    children: ReactNode,
    followed: boolean,
  ): ReactNode;
  code(source: string, language?: string | null): ReactNode;
  citation(footnote: CitationFootNote): ReactNode;
  callout(
    data: NonNullable<
      Extract<MarkdownPreviewNode, { type: "blockquote" }>["data"]
    >,
    body: ReactNode,
  ): ReactNode;
  inlineHtml(
    children: MarkdownAST[],
    start: number,
  ): { endIndex: number; view: ReactNode } | null;
  annotation(body: string): ReactNode;
  documentLink(url: string, children: ReactNode): ReactNode;
  image(url: string, alt: string): ReactNode;
  equation(source: string, display: boolean): ReactNode;
}

/** Host-specific interactivity is limited to saved answers. Raw HTML is never mounted. */
export function MarkdownPreview({
  source,
  presentation,
}: {
  source: string;
  presentation?: MarkdownPreviewPresentation;
}) {
  return useMemo(() => {
    const literal = () => (
      <MyoxusText component="p" inherit preserveWhitespace>
        {source}
      </MyoxusText>
    );
    let root: ReturnType<typeof parseMarkdownPreview>;
    const footnotes = new Map<
      string,
      { number: number; reference?: CitationFootNote["reference"] }
    >();
    try {
      root = parseMarkdownPreview(source, !!presentation);
      if (presentation)
        for (const node of root.children) {
          if (node.type !== "footnoteDefinition") continue;
          const reference = citationDefinition(node);
          if (reference)
            for (const prop of ["url", "favicon"] as const) {
              const value = reference[prop];
              if (value && !value.includes(":") && value.includes("%"))
                reference[prop] = decodeURIComponent(value);
            }
          footnotes.set(node.identifier, {
            number: footnotes.size + 1,
            reference,
          });
        }
    } catch {
      return literal();
    }
    const definitions = new Map(
      root.children
        .filter((node) => node.type === "definition")
        .map((node) => [node.identifier, node]),
    );
    function renderChildren(nodes: MarkdownAST[]): ReactNode[] {
      const output: ReactNode[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.type === "html" && presentation) {
          const group = presentation.inlineHtml(nodes, i);
          if (group) {
            output.push(<Fragment key={i}>{group.view}</Fragment>);
            i = group.endIndex;
            continue;
          }
        }
        output.push(
          render(
            n,
            i,
            n.type === "heading" &&
              nodes
                .slice(i + 1)
                .some(
                  (v) =>
                    v.type !== "definition" && v.type !== "footnoteDefinition",
                ),
          ),
        );
      }
      return output;
    }
    const render = (
      node: MarkdownPreviewNode,
      index = 0,
      followed = false,
    ): ReactNode => {
      const children =
        "children" in node &&
        !["table", "listItem", "footnoteDefinition"].includes(node.type)
          ? renderChildren(node.children)
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
          if (presentation)
            return (
              <Fragment key={index}>
                {presentation.heading(node.depth, children, followed)}
              </Fragment>
            );
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
          if (presentation)
            return (
              <Fragment key={index}>
                {presentation.code(node.value, node.lang)}
              </Fragment>
            );
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
          if (presentation && node.data?.isCallout)
            return (
              <Fragment key={index}>
                {presentation.callout(node.data, children)}
              </Fragment>
            );
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
              <Fragment key={i}>{renderChildren(child.children)}</Fragment>
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
        case "link":
        case "linkReference": {
          if (
            presentation &&
            node.type === "link" &&
            typeof (node.data as WikiLinkData | undefined)?.myoxusWikiSource ===
              "string"
          )
            return (node.data as WikiLinkData).myoxusWikiSource;
          const link =
            node.type === "link" ? node : definitions.get(node.identifier);
          const url = link?.url ?? "";
          const docLink = presentation?.documentLink(url, children);
          if (docLink) return <Fragment key={index}>{docLink}</Fragment>;
          const href = safeHref(url);
          return href ? (
            element("a", {
              href,
              title: link?.title ?? undefined,
              target: "_blank",
              rel: "noopener noreferrer",
            })
          ) : (
            <Fragment key={index}>{children}</Fragment>
          );
        }
        case "imageReference":
          if (presentation) {
            const url = definitions.get(node.identifier)?.url ?? "";
            return (
              <Fragment key={index}>
                {presentation.image(url, node.alt ?? "")}
              </Fragment>
            );
          }
          return (
            <span key={index}>
              {source.slice(
                node.position?.start.offset,
                node.position?.end.offset,
              )}
            </span>
          );
        case "image":
          if (presentation)
            return (
              <Fragment key={index}>
                {presentation.image(node.url, node.alt ?? "")}
              </Fragment>
            );
          return <span key={index}>{node.alt || node.url}</span>;
        case "math":
        case "inlineMath":
          return (
            <Fragment key={index}>
              {presentation?.equation(node.value, node.type === "math")}
            </Fragment>
          );
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
                  renderChildren(cell.children),
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
        case "myoxusAnnotationBlock":
        case "myoxusBlockAnchor":
          return null;
        case "myoxusAnnotation":
          return (
            <Fragment key={index}>
              {presentation?.annotation(node.value)}
            </Fragment>
          );
        case "myoxusDocumentEmbed":
          return node.value;
        case "footnoteReference":
          if (presentation) {
            const def = footnotes.get(node.identifier);
            const reference = def?.reference;
            if (reference) {
              return (
                <Fragment key={index}>
                  {presentation.citation({
                    label: node.label ?? node.identifier,
                    reference,
                  })}
                </Fragment>
              );
            }
            return <sup key={index}>[{def?.number ?? "?"}]</sup>;
          }
          return source.slice(
            node.position?.start.offset,
            node.position?.end.offset,
          );
        case "footnoteDefinition":
          return presentation
            ? null
            : source.slice(
                node.position?.start.offset,
                node.position?.end.offset,
              );
        case "html":
          return <span key={index}>{node.value}</span>;
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
    try {
      return render(root);
    } catch {
      return literal();
    }
  }, [source, presentation]);
}
