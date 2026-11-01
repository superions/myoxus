import type {
  Link,
  Literal,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Text,
} from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { getMarkdownCodeRanges } from "../annotation-source";

export const WIKILINK_SCHEME = "myoxus-wikilink:";

type WikiLinkData = {
  myoxusWikiAlias?: string;
  myoxusWikiSource: string;
  myoxusWikiTarget: string;
  myoxusWikiUnsupported?: boolean;
  myoxusWikiEmbed?: boolean;
};

/** A block-position relation; the existing inline adapter still owns resolution. */
export interface DocumentEmbed extends Literal {
  type: "myoxusDocumentEmbed";
  value: string;
  reference?: Link;
}
declare module "mdast" {
  interface ParagraphData {
    /** Source provenance; never interpreted as a native block identifier. */
    markdownAnchor?: string;
  }
  interface HeadingData {
    markdownAnchor?: string;
    collapsed?: boolean;
  }
  interface ListItemData {
    markdownAnchor?: string;
  }
  interface BlockquoteData {
    markdownAnchor?: string;
  }
  interface PhrasingContentMap {
    myoxusBlockAnchor: BlockAnchor;
  }
  interface RootContentMap {
    myoxusDocumentEmbed: DocumentEmbed;
    myoxusBlockAnchor: BlockAnchor;
  }
  interface BlockContentMap {
    myoxusDocumentEmbed: DocumentEmbed;
  }
}

export interface BlockAnchor extends Literal {
  type: "myoxusBlockAnchor";
  value: string;
}

export const validMarkdownAnchor = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9-]+$/.test(value);

/** Append raw syntax only from validated native provenance; literal text escapes it. */
export function withMarkdownAnchor(
  children: PhrasingContent[],
  anchor: unknown,
): PhrasingContent[] {
  if (anchor === undefined) return children;
  if (!validMarkdownAnchor(anchor))
    throw new Error("Invalid Markdown block anchor");
  return [...children, { type: "myoxusBlockAnchor", value: ` ^${anchor}` }];
}

/** Extend the existing general syntax adapter, never scan code/annotation bodies. */
export const remarkBlockAnchors: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value ?? "");
  visit(tree, (node, _index, parent) => {
    if (node.type !== "paragraph" && node.type !== "heading") return;
    const last = node.children.at(-1);
    if (last?.type !== "text") return;
    const match = /(?:^|\s)\^([a-zA-Z0-9-]+)[ \t]*$/.exec(last.value);
    const start = last.position?.start.offset;
    const end = last.position?.end.offset;
    if (!match || start === undefined || end === undefined) return;
    // An anchor-only line belongs to a preceding block, not a new empty target.
    // It stays literal until the container-aware reference owner resolves it.
    if (node.children.length === 1 && !last.value.slice(0, match.index).trim())
      return;
    const raw = source.slice(start, end);
    if (!/(?:^|\s)\^([a-zA-Z0-9-]+)[ \t]*$/.test(raw)) return;
    last.value = last.value.slice(0, match.index).trimEnd();
    if (!last.value) node.children.pop();
    const previous = node.children.at(-1);
    if (previous?.type === "text") previous.value = previous.value.trimEnd();
    const owner =
      parent?.type === "listItem" && parent.children[0] === node
        ? parent
        : parent?.type === "blockquote" && parent.children[0] === node
          ? parent
          : node;
    (owner.data ??= {}).markdownAnchor = match[1];
  });
};

function openingBracketIsEscaped(
  node: Text,
  valueOffset: number,
  source: string,
) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const raw = source.slice(start, end);
  let decodedOffset = 0;
  for (let rawOffset = 0; rawOffset < raw.length; rawOffset++) {
    const escaped = raw[rawOffset] === "\\" && rawOffset + 1 < raw.length;
    if (decodedOffset === valueOffset) return escaped;
    if (escaped) rawOffset++;
    decodedOffset++;
  }
  return false;
}

function parseText(node: Text, source: string): PhrasingContent[] {
  const output: PhrasingContent[] = [];
  const value = node.value;
  let literalStart = 0;
  let cursor = 0;
  while (cursor + 1 < value.length) {
    if (
      value[cursor] !== "[" ||
      value[cursor + 1] !== "[" ||
      openingBracketIsEscaped(node, cursor, source)
    ) {
      cursor++;
      continue;
    }
    const embed = cursor > 0 && value[cursor - 1] === "!";
    const close = value.indexOf("]]", cursor + 2);
    if (close < 0) break;
    if (embed && openingBracketIsEscaped(node, cursor - 1, source)) {
      cursor = close + 2;
      continue;
    }
    const inner = value.slice(cursor + 2, close);
    const separator = inner.indexOf("|");
    const target = (separator < 0 ? inner : inner.slice(0, separator)).trim();
    const alias = separator < 0 ? undefined : inner.slice(separator + 1).trim();
    if (!target) {
      cursor = close + 2;
      continue;
    }
    const syntaxStart = embed ? cursor - 1 : cursor;
    if (syntaxStart > literalStart)
      output.push({
        type: "text",
        value: value.slice(literalStart, syntaxStart),
      });
    const rawSyntax = value.slice(syntaxStart, close + 2);
    const data: WikiLinkData = {
      myoxusWikiAlias: alias || undefined,
      myoxusWikiSource: rawSyntax,
      myoxusWikiTarget: target,
      myoxusWikiUnsupported: embed || target.includes("#"),
      myoxusWikiEmbed: embed,
    };
    output.push({
      type: "link",
      url: WIKILINK_SCHEME + encodeURIComponent(target),
      children: [{ type: "text", value: alias || target }],
      data,
    } as Link);
    cursor = close + 2;
    literalStart = cursor;
  }
  if (literalStart === 0) return [node];
  if (literalStart < value.length)
    output.push({ type: "text", value: value.slice(literalStart) });
  return output;
}

/** Recognize wikilinks only inside parsed text nodes, never code nodes. */
export const remarkWikilink: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value ?? "");
  const protectedRanges = getMarkdownCodeRanges(source);
  visit(tree, "text", (node, index, parent) => {
    if (index === undefined || !parent || parent.type === "link") return;
    if (
      protectedRanges.some(
        (range) =>
          range.start <= (node.position?.start.offset ?? -1) &&
          range.end >= (node.position?.end.offset ?? Infinity),
      )
    )
      return;
    const replacement = parseText(node, source);
    if (replacement.length !== 1 || replacement[0] !== node) {
      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    }
    return;
  });
  // A synced-document view is a block, never a text attribute. Split surrounding
  // prose into ordered paragraphs while retaining its rich inline wrappers.
  visit(tree, "paragraph", (node, index, parent) => {
    if (
      index === undefined ||
      !parent ||
      !["root", "listItem", "blockquote"].includes(parent.type)
    )
      return;
    const parts = splitEmbeds(node.children);
    if (!parts.some((part) => !Array.isArray(part))) return;
    const replacement: RootContent[] = parts.flatMap<RootContent>((part) =>
      Array.isArray(part)
        ? part.length &&
          part.some((child) => child.type !== "text" || child.value.trim())
          ? [{ ...node, children: part } as Paragraph]
          : []
        : [
            {
              type: "myoxusDocumentEmbed",
              value: (part.data as WikiLinkData).myoxusWikiSource,
              reference: part,
            } as DocumentEmbed,
          ],
    );
    parent.children.splice(
      index,
      1,
      ...(replacement as typeof parent.children),
    );
    return index + replacement.length;
  });
};

function splitEmbeds(
  children: PhrasingContent[],
): (PhrasingContent[] | Link)[] {
  const parts: (PhrasingContent[] | Link)[] = [[]];
  for (const child of children) {
    const data = child.data as WikiLinkData | undefined;
    if (
      child.type === "link" &&
      data?.myoxusWikiEmbed &&
      !data.myoxusWikiTarget.includes("#")
    ) {
      parts.push(child, []);
    } else if (
      ["strong", "emphasis", "delete"].includes(child.type) &&
      "children" in child
    ) {
      for (const part of splitEmbeds(child.children)) {
        if (Array.isArray(part)) {
          if (part.length)
            (parts[parts.length - 1] as PhrasingContent[]).push({
              ...child,
              children: part,
            } as PhrasingContent);
        } else parts.push(part, []);
      }
    } else (parts[parts.length - 1] as PhrasingContent[]).push(child);
  }
  return parts;
}

/** Raw relation syntax is emitted only for a canonical native embed block. */
export const remarkDocumentEmbedWriter: Plugin<[], Root> = function () {
  (this.data().toMarkdownExtensions ??= []).push({
    handlers: {
      myoxusDocumentEmbed: (node) => (node as DocumentEmbed).value,
      myoxusBlockAnchor: (node) => (node as BlockAnchor).value,
    },
    unsafe: [{ character: "^", inConstruct: ["phrasing"] }],
  });
};

export type { WikiLinkData };
