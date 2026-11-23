// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Literal, Nodes } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkGfm } from "./gfm";
import { preprocessCitationDefinitions } from "./footnotes";
import { MarkdownAdapter } from "./markdown";

export type MarkdownPreviewNode =
  Nodes | (Literal & { type: "math" | "inlineMath" });

/** Saved answers share the editor grammar. Malformed input remains readable as literal Markdown. */
export function parseMarkdownPreview(source: string, editorSyntax = false) {
  if (editorSyntax)
    return MarkdownAdapter.parseAst(
      source.includes("[^") ? preprocessCitationDefinitions(source) : source,
    );
  return unified().use(remarkParse).use(remarkGfm).parse(source);
}
