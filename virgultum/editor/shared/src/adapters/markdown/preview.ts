// SPDX-License-Identifier: AGPL-3.0-or-later

import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkGfm } from "./gfm";

export type { Nodes as MarkdownPreviewNode } from "mdast";

/** Parse file previews without importing assets, resolving workspace links or writing a Store. */
export function parseMarkdownPreview(source: string) {
  return unified().use(remarkParse).use(remarkGfm).parse(source);
}
