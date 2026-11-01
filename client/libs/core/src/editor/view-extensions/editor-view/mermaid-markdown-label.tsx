// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment, type ReactNode } from "react";

/** The existing diagram label subset renders escaped React text in SVG and DOM, never raw HTML. */
export function renderSafeMarkdownLabel(
  source: string,
  capacity = Infinity,
  surface: "svg" | "dom" = "svg",
): ReactNode {
  const tokens = source.split(/(`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g);
  let remaining = capacity;
  const nodes: ReactNode[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!token) continue;
    if (remaining <= 0) break;
    const strong =
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"));
    const emphasis = !strong && token.startsWith("*") && token.endsWith("*");
    const code = token.startsWith("`") && token.endsWith("`");
    const content = strong
      ? token.slice(2, -2)
      : emphasis || code
        ? token.slice(1, -1)
        : token;
    const visible = content.slice(0, remaining);
    remaining -= visible.length;
    nodes.push(
      surface === "svg" ? (
        <tspan
          fontFamily={code ? "monospace" : undefined}
          fontStyle={emphasis ? "italic" : undefined}
          fontWeight={strong ? "bold" : undefined}
          key={index}
        >
          {visible}
        </tspan>
      ) : strong ? (
        <strong key={index}>{visible}</strong>
      ) : emphasis ? (
        <em key={index}>{visible}</em>
      ) : code ? (
        <code key={index}>{visible}</code>
      ) : (
        <Fragment key={index}>{visible}</Fragment>
      ),
    );
  }
  const plainLength = source.replace(/`|\*\*?|__/g, "").length;
  if (plainLength > capacity) nodes.push(<Fragment key="ellipsis">…</Fragment>);
  return nodes;
}
