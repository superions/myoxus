import { uniqBy } from "lodash-es";
import {
  Array as YArray,
  type Doc as YDoc,
  Map as YMap,
  Text as YText,
} from "yjs";

import { deltaToMd, getConverters } from "./doc-parser/delta-to-md";

type IndexerTextAttributes = {
  reference?: {
    pageId?: string;
    params?: Record<string, unknown>;
    title?: string;
    type?: string;
  };
  [key: string]: unknown;
};

type IndexerTextDelta = {
  insert: unknown;
  attributes?: IndexerTextAttributes;
};

export interface BlockDocumentInfo {
  docId: string;
  blockId: string;
  content?: string | string[];
  flavour: string;
  blob?: string[];
  refDocId?: string[];
  ref?: string[];
  parentFlavour?: string;
  parentBlockId?: string;
  additional?: {
    databaseName?: string;
    displayMode?: string;
    noteBlockId?: string;
  };
  yblock: YMap<any>;
  markdownPreview?: string;
}

const bookmarkFlavours = new Set([
  "myoxus:bookmark",
  "myoxus:embed-youtube",
  "myoxus:embed-figma",
  "myoxus:embed-github",
  "myoxus:embed-loom",
]);

const collectInlineReferences = (
  deltas: IndexerTextDelta[],
): { refDocId: string; ref: string }[] =>
  uniqBy(
    deltas
      .flatMap((delta) => {
        if (
          delta.attributes &&
          delta.attributes.reference &&
          delta.attributes.reference.pageId
        ) {
          const { pageId: refDocId, params = {} } = delta.attributes.reference;
          return {
            refDocId,
            ref: JSON.stringify({ docId: refDocId, ...params }),
          };
        }
        return null;
      })
      .filter((ref): ref is { refDocId: string; ref: string } => ref !== null),
    (item) => item.ref,
  );

const getTextDeltasFromCellValue = (
  value: unknown,
): IndexerTextDelta[] | null => {
  if (!value) {
    return null;
  }

  if (value instanceof YText) {
    return value.toDelta() as IndexerTextDelta[];
  }

  if (typeof value === "object" && value !== null) {
    const maybeText = value as { yText?: unknown };
    if (maybeText.yText instanceof YText) {
      return maybeText.yText.toDelta() as IndexerTextDelta[];
    }
  }

  if (value instanceof YMap) {
    const marker = value.get("$virgultum:internal:text$");
    const delta = value.get("delta");
    if (marker) {
      if (delta instanceof YArray) {
        return delta
          .toArray()
          .map((entry) => (entry instanceof YMap ? entry.toJSON() : entry)) as
          IndexerTextDelta[] | null;
      }
      if (Array.isArray(delta)) {
        return delta as IndexerTextDelta[];
      }
    }
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "$virgultum:internal:text$" in value
  ) {
    const delta = (value as { delta?: unknown }).delta;
    if (delta instanceof YArray) {
      return delta.toArray() as IndexerTextDelta[];
    }
    if (Array.isArray(delta)) {
      return delta as IndexerTextDelta[];
    }
  }

  return null;
};

function generateMarkdownPreviewBuilder(
  workspaceId: string,
  blocks: BlockDocumentInfo[],
  _yRootDoc?: YDoc,
) {
  const baseUrl = `/workspace/${workspaceId}`;

  function getDocLink(docId: string, blockId: string) {
    const searchParams = new URLSearchParams();
    searchParams.set("blockIds", blockId);
    return `${baseUrl}/${docId}?${searchParams.toString()}`;
  }

  const markdownPreviewCache = new WeakMap<BlockDocumentInfo, string | null>();

  const markdownConverters = getConverters({
    convertInlineReferenceLink: (reference) => ({
      // The delta's inserted text is already the visible link label. Adding a
      // second resolved title here would duplicate it in the preview.
      title: "",
      link: `${baseUrl}/${reference.pageId}`,
    }),
  });

  function trimCodeBlock(markdown: string) {
    const lines = markdown.split("\n").filter((line) => line.trim() !== "");
    if (lines.length > 5) {
      return [...lines.slice(0, 4), "...", lines.at(-1), ""].join("\n");
    }
    return [...lines, ""].join("\n");
  }

  function trimParagraph(markdown: string) {
    const lines = markdown.split("\n").filter((line) => line.trim() !== "");

    if (lines.length > 3) {
      return [...lines.slice(0, 3), "...", lines.at(-1), ""].join("\n");
    }

    return [...lines, ""].join("\n");
  }

  function getListDepth(block: BlockDocumentInfo) {
    let parentBlockCount = 0;
    let currentBlock: BlockDocumentInfo | undefined = block;
    do {
      currentBlock = blocks.find(
        (b) => b.blockId === currentBlock?.parentBlockId,
      );

      // reach the root block. do not count it.
      if (!currentBlock || currentBlock.flavour !== "myoxus:list") {
        break;
      }
      parentBlockCount++;
    } while (currentBlock);
    return parentBlockCount;
  }

  // only works for list block
  function indentMarkdown(markdown: string, depth: number) {
    if (depth <= 0) {
      return markdown;
    }

    return (
      markdown
        .split("\n")
        .map((line) => "    ".repeat(depth) + line)
        .join("\n") + "\n"
    );
  }

  const generateDatabaseMarkdownPreview = (block: BlockDocumentInfo) => {
    let dbBlock: BlockDocumentInfo | null = null;

    if (block.flavour === "myoxus:database") {
      dbBlock = block;
    } else {
      const parentBlock = blocks.find((b) => b.blockId === block.parentBlockId);

      if (parentBlock?.flavour === "myoxus:database") {
        dbBlock = parentBlock;
      }
    }

    if (!dbBlock) {
      return null;
    }

    const url = getDocLink(block.docId, dbBlock.blockId);
    const title = dbBlock.additional?.databaseName;

    return `[database · ${title || "Untitled"}][](${url})\n`;
  };

  const generateImageMarkdownPreview = (block: BlockDocumentInfo) => {
    const info = ["an image block"];
    const sourceId = block.yblock.get("prop:sourceId");
    const caption = block.yblock.get("prop:caption");

    if (sourceId) {
      info.push(`file id ${String(sourceId)}`);
    }

    if (caption) {
      info.push(`with caption ${String(caption)}`);
    }

    return info.join(", ") + "\n";
  };

  const generateEmbedMarkdownPreview = (block: BlockDocumentInfo) => {
    const pageId = block.yblock.get("prop:pageId");
    if (typeof pageId !== "string") {
      return null;
    }

    const url = getDocLink(block.docId, block.blockId);

    return `[](${url})\n`;
  };

  const generateLatexMarkdownPreview = (block: BlockDocumentInfo) => {
    let content =
      typeof block.content === "string"
        ? block.content.trim()
        : block.content?.join("").trim();

    content = content?.split("\n").join(" ") ?? "";

    return `LaTeX, with value ${content}\n`;
  };

  const generateBookmarkMarkdownPreview = (block: BlockDocumentInfo) => {
    const title = block.yblock.get("prop:title")?.toString() ?? "";
    const url = block.yblock.get("prop:url")?.toString() ?? "";
    return `[${title}](${url})\n`;
  };

  const generateAttachmentMarkdownPreview = (block: BlockDocumentInfo) => {
    const name = block.yblock.get("prop:name")?.toString() ?? "";
    const sourceId = block.yblock.get("prop:sourceId")?.toString() ?? "";
    return `[${name}](${sourceId})\n`;
  };

  const generateTableMarkdownPreview = (block: BlockDocumentInfo) => {
    const url = getDocLink(block.docId, block.blockId);

    return `[table][](${url})\n`;
  };

  const generateTextMarkdownPreview = (block: BlockDocumentInfo) => {
    const text = block.yblock.get("prop:text");
    if (!(text instanceof YText)) {
      return typeof block.content === "string" ? block.content : null;
    }

    const converted = deltaToMd(text.toDelta(), markdownConverters);
    const type = block.yblock.get("prop:type")?.toString();

    if (block.flavour === "myoxus:code") {
      const language =
        block.yblock.get("prop:language")?.toString().toLowerCase() || "txt";
      return `\`\`\`${language}\n${text.toString()}\n\`\`\`\n`;
    }

    if (block.flavour === "myoxus:list") {
      const prefix =
        type === "numbered"
          ? "1. "
          : type === "todo"
            ? block.yblock.get("prop:checked")
              ? "- [x] "
              : "- [ ] "
            : "- ";
      return prefix + converted;
    }

    const paragraphPrefix =
      type && /^h[1-6]$/.test(type)
        ? `${"#".repeat(Number(type.slice(1)))} `
        : type === "quote"
          ? "> "
          : "";
    return paragraphPrefix + converted;
  };

  const generateMarkdownPreview = async (block: BlockDocumentInfo) => {
    if (markdownPreviewCache.has(block)) {
      return markdownPreviewCache.get(block);
    }
    const flavour = block.flavour;
    let markdown: string | null = null;

    if (
      flavour === "myoxus:paragraph" ||
      flavour === "myoxus:list" ||
      flavour === "myoxus:code"
    ) {
      markdown =
        block.parentFlavour === "myoxus:database"
          ? generateDatabaseMarkdownPreview(block)
          : generateTextMarkdownPreview(block);

      if (markdown) {
        if (flavour === "myoxus:code") {
          markdown = trimCodeBlock(markdown);
        } else if (flavour === "myoxus:paragraph") {
          markdown = trimParagraph(markdown);
        }
      }
    } else if (flavour === "myoxus:database") {
      markdown = generateDatabaseMarkdownPreview(block);
    } else if (
      flavour === "myoxus:embed-linked-doc" ||
      flavour === "myoxus:embed-synced-doc"
    ) {
      markdown = generateEmbedMarkdownPreview(block);
    } else if (flavour === "myoxus:attachment") {
      markdown = generateAttachmentMarkdownPreview(block);
    } else if (flavour === "myoxus:image") {
      markdown = generateImageMarkdownPreview(block);
    } else if (flavour === "myoxus:surface" || flavour === "myoxus:page") {
      // skip
    } else if (flavour === "myoxus:latex") {
      markdown = generateLatexMarkdownPreview(block);
    } else if (bookmarkFlavours.has(flavour)) {
      markdown = generateBookmarkMarkdownPreview(block);
    } else if (flavour === "myoxus:table") {
      markdown = generateTableMarkdownPreview(block);
    } else if (flavour === "myoxus:bpmn") {
      // A literal title placeholder in surrounding-link previews, never XML or
      // stored SVG. A longer native Markdown code span keeps title markup inert.
      const title = String(block.content ?? "").replace(/[\r\n]/g, " ");
      let fenceLength = 1;
      for (const match of title.matchAll(/`+/g))
        fenceLength = Math.max(fenceLength, match[0].length + 1);
      const fence = "`".repeat(fenceLength);
      markdown = `${fence} ${title} ${fence}`;
    } else {
      console.warn(`unknown flavour: ${flavour}`);
    }

    if (markdown && flavour === "myoxus:list") {
      const blockDepth = getListDepth(block);
      markdown = indentMarkdown(markdown, Math.max(0, blockDepth));
    }

    markdownPreviewCache.set(block, markdown);
    return markdown;
  };

  return generateMarkdownPreview;
}

// remove the indent of the first line of list
// e.g.,
// ```
//     - list item 1
//       - list item 2
// ```
// becomes
// ```
// - list item 1
//   - list item 2
// ```
function unindentMarkdown(markdown: string) {
  const lines = markdown.split("\n");
  const res: string[] = [];
  let firstListFound = false;
  let baseIndent = 0;

  for (let current of lines) {
    const indent = current.match(/^\s*/)?.[0]?.length ?? 0;

    if (indent > 0) {
      if (!firstListFound) {
        // For the first list item, remove all indentation
        firstListFound = true;
        baseIndent = indent;
        current = current.trimStart();
      } else {
        // For subsequent list items, maintain relative indentation
        current =
          " ".repeat(Math.max(0, indent - baseIndent)) + current.trimStart();
      }
    }

    res.push(current);
  }

  return res.join("\n");
}

export async function readAllBlocksFromDoc({
  ydoc,
  rootYDoc,
  spaceId,
  maxSummaryLength,
}: {
  ydoc: YDoc;
  rootYDoc?: YDoc;
  spaceId: string;
  maxSummaryLength?: number;
}): Promise<
  | {
      blocks: BlockDocumentInfo[];
      title: string;
      summary: string;
    }
  | undefined
> {
  let docTitle = "";
  let summary = "";
  maxSummaryLength ??= 1000;
  const blockDocuments: BlockDocumentInfo[] = [];

  const generateMarkdownPreview = generateMarkdownPreviewBuilder(
    spaceId,
    blockDocuments,
    rootYDoc,
  );

  const blocks = ydoc.getMap<any>("blocks");
  if (blocks.size === 0) {
    return undefined;
  }

  // build a parent map for quick lookup
  // for each block, record its parent id
  const parentMap: Record<string, string | null> = {};
  for (const [id, block] of blocks.entries()) {
    const children = block.get("sys:children") as YArray<string> | undefined;
    if (children instanceof YArray && children.length) {
      for (const child of children) {
        parentMap[child] = id;
      }
    }
  }

  // find the nearest block that satisfies the predicate
  const nearest = (
    blockId: string,
    predicate: (block: YMap<any>) => boolean,
  ) => {
    let current: string | null = blockId;
    while (current) {
      const block = blocks.get(current);
      if (block && predicate(block)) {
        return block;
      }
      current = parentMap[current] ?? null;
    }
    return null;
  };

  const nearestByFlavour = (blockId: string, flavour: string) =>
    nearest(blockId, (block) => block.get("sys:flavour") === flavour);

  let rootBlockId: string | null = null;
  for (const block of blocks.values()) {
    const flavour = block.get("sys:flavour")?.toString();
    const blockId = block.get("sys:id")?.toString();
    if (flavour === "myoxus:page" && blockId) {
      rootBlockId = blockId;
    }
  }

  if (!rootBlockId) {
    return undefined;
  }

  const queue: { parent?: string; id: string }[] = [{ id: rootBlockId }];
  const visited = new Set<string>(); // avoid loop

  const pushChildren = (id: string, block: YMap<any>) => {
    const children = block.get("sys:children");
    if (children instanceof YArray && children.length) {
      for (let i = children.length - 1; i >= 0; i--) {
        const childId = children.get(i);
        if (childId && !visited.has(childId)) {
          queue.push({ parent: id, id: childId });
          visited.add(childId);
        }
      }
    }
  };

  // #region first loop - generate block base info
  while (queue.length) {
    const next = queue.pop();
    if (!next) {
      break;
    }

    const { parent: parentBlockId, id: blockId } = next;
    const block = blockId ? blocks.get(blockId) : null;
    const parentBlock = parentBlockId ? blocks.get(parentBlockId) : null;
    if (!block) {
      break;
    }

    const flavour = block.get("sys:flavour")?.toString();
    const parentFlavour = parentBlock?.get("sys:flavour")?.toString();
    const noteBlock = nearestByFlavour(blockId, "myoxus:note");

    // display mode:
    // - both: page and edgeless -> fallback to page
    // - page: only page -> page
    // - edgeless: only edgeless -> edgeless
    // - undefined: edgeless (assuming it is a normal element on the edgeless)
    let displayMode = noteBlock?.get("prop:displayMode") ?? "edgeless";

    if (displayMode === "both") {
      displayMode = "page";
    }

    const noteBlockId: string | undefined = noteBlock
      ?.get("sys:id")
      ?.toString();

    pushChildren(blockId, block);

    const commonBlockProps = {
      docId: ydoc.guid,
      flavour,
      blockId,
      yblock: block,
      additional: { displayMode, noteBlockId },
    };

    if (flavour === "myoxus:page") {
      docTitle = block.get("prop:title").toString();
      blockDocuments.push({ ...commonBlockProps, content: docTitle });
    } else if (
      flavour === "myoxus:paragraph" ||
      flavour === "myoxus:list" ||
      flavour === "myoxus:code"
    ) {
      const text = block.get("prop:text") as YText;

      if (!text) {
        continue;
      }

      const deltas = text.toDelta() as IndexerTextDelta[];
      const refs = collectInlineReferences(deltas);

      const databaseName =
        flavour === "myoxus:paragraph" && parentFlavour === "myoxus:database" // if block is a database row
          ? parentBlock?.get("prop:title")?.toString()
          : undefined;

      blockDocuments.push({
        ...commonBlockProps,
        content: text.toString(),
        ...refs.reduce<{ refDocId: string[]; ref: string[] }>(
          (prev, curr) => {
            prev.refDocId.push(curr.refDocId);
            prev.ref.push(curr.ref);
            return prev;
          },
          { refDocId: [], ref: [] },
        ),
        parentFlavour,
        parentBlockId,
        additional: { ...commonBlockProps.additional, databaseName },
      });

      if (maxSummaryLength > 0) {
        summary += text.toString();
        maxSummaryLength -= text.length;
      }
    } else if (
      flavour === "myoxus:embed-linked-doc" ||
      flavour === "myoxus:embed-synced-doc"
    ) {
      const pageId = block.get("prop:pageId");
      if (typeof pageId === "string") {
        // reference info
        const params = block.get("prop:params") ?? {};
        blockDocuments.push({
          ...commonBlockProps,
          refDocId: [pageId],
          ref: [JSON.stringify({ docId: pageId, ...params })],
          parentFlavour,
          parentBlockId,
        });
      }
    } else if (flavour === "myoxus:attachment") {
      const blobId = block.get("prop:sourceId");
      if (typeof blobId === "string") {
        blockDocuments.push({
          ...commonBlockProps,
          blob: [blobId],
          content: block.get("prop:name")?.toString() ?? "",
          parentFlavour,
          parentBlockId,
        });
      }
    } else if (flavour === "myoxus:image") {
      const blobId = block.get("prop:sourceId");
      if (typeof blobId === "string") {
        blockDocuments.push({
          ...commonBlockProps,
          blob: [blobId],
          content: block.get("prop:caption")?.toString() ?? "",
          parentFlavour,
          parentBlockId,
        });
      }
    } else if (flavour === "myoxus:surface") {
      const texts = [];

      const elementsObj = block.get("prop:elements");
      if (!(
        elementsObj instanceof YMap &&
        (elementsObj.get("type") === "$blocksuite:internal:native$" ||
          elementsObj.get("type") === "$virgultum:internal:native$")
      )) {
        continue;
      }
      const elements = elementsObj.get("value") as YMap<any>;
      if (!(elements instanceof YMap)) {
        continue;
      }

      for (const element of elements.values()) {
        if (!(element instanceof YMap)) {
          continue;
        }
        const text = element.get("text") as YText;
        if (!text) {
          continue;
        }

        texts.push(text.toString());
      }

      blockDocuments.push({
        ...commonBlockProps,
        content: texts,
        parentFlavour,
        parentBlockId,
      });
    } else if (flavour === "myoxus:database") {
      const texts = [];
      const columnsObj = block.get("prop:columns");
      const databaseTitle = block.get("prop:title");
      if (databaseTitle instanceof YText) {
        texts.push(databaseTitle.toString());
      }
      if (columnsObj instanceof YArray) {
        for (const column of columnsObj) {
          if (!(column instanceof YMap)) {
            continue;
          }
          if (typeof column.get("name") === "string") {
            texts.push(column.get("name"));
          }

          const data = column.get("data");
          if (!(data instanceof YMap)) {
            continue;
          }
          const options = data.get("options");
          if (!(options instanceof YArray)) {
            continue;
          }
          for (const option of options) {
            if (!(option instanceof YMap)) {
              continue;
            }
            const value = option.get("value");
            if (typeof value === "string") {
              texts.push(value);
            }
          }
        }
      }

      const databaseRefs: { refDocId: string; ref: string }[] = [];
      const cellsObj = block.get("prop:cells");
      if (cellsObj instanceof YMap) {
        for (const row of cellsObj.values()) {
          if (!(row instanceof YMap)) {
            continue;
          }
          for (const cell of row.values()) {
            if (!(cell instanceof YMap)) {
              continue;
            }
            const deltas = getTextDeltasFromCellValue(cell.get("value"));
            if (!deltas?.length) {
              continue;
            }
            const refs = collectInlineReferences(deltas);
            if (refs.length) {
              databaseRefs.push(...refs);
            }
          }
        }
      }

      blockDocuments.push({
        ...commonBlockProps,
        content: texts,
        additional: {
          ...commonBlockProps.additional,
          databaseName: databaseTitle?.toString(),
        },
        ...(databaseRefs.length
          ? databaseRefs.reduce<{ refDocId: string[]; ref: string[] }>(
              (prev, curr) => {
                prev.refDocId.push(curr.refDocId);
                prev.ref.push(curr.ref);
                return prev;
              },
              { refDocId: [], ref: [] },
            )
          : {}),
      });
    } else if (flavour === "myoxus:bpmn") {
      // Native indexing owns title-only text; canonical heads and derived
      // previews are not searchable content or inputs to the worker parser.
      const value = block.get("prop:title");
      const title =
        value instanceof YText
          ? value.toString().trim()
          : typeof value === "string"
            ? value.trim()
            : "";
      blockDocuments.push({
        ...commonBlockProps,
        content: `BPMN: ${title || "BPMN Diagram"}`,
      });
    } else if (flavour === "myoxus:latex") {
      blockDocuments.push({
        ...commonBlockProps,
        content: block.get("prop:latex")?.toString() ?? "",
      });
    } else if (flavour === "myoxus:table") {
      const tableCellText = (value: unknown) => {
        if (value instanceof YText) {
          return value.toString();
        }
        return typeof value === "string" ? value : "";
      };
      const contents = Array.from<string>(block.keys())
        .map((key) => {
          if (key.startsWith("prop:cells.") && key.endsWith(".text")) {
            return tableCellText(block.get(key));
          }
          return "";
        })
        .filter(Boolean);
      blockDocuments.push({
        ...commonBlockProps,
        content: contents,
      });
    } else if (bookmarkFlavours.has(flavour)) {
      blockDocuments.push({ ...commonBlockProps });
    }
  }
  // #endregion

  // #region second loop - generate markdown preview
  const TARGET_PREVIEW_CHARACTER = 500;
  const TARGET_PREVIOUS_BLOCK = 1;
  const TARGET_FOLLOW_BLOCK = 4;
  for (const block of blockDocuments) {
    if (block.ref?.length) {
      const target = block;

      // should only generate the markdown preview belong to the same affine:note
      const noteBlock = nearestByFlavour(block.blockId, "myoxus:note");

      const sameNoteBlocks = noteBlock
        ? blockDocuments.filter(
            (candidate) =>
              nearestByFlavour(candidate.blockId, "myoxus:note") === noteBlock,
          )
        : [];

      // only generate markdown preview for reference blocks
      let previewText = (await generateMarkdownPreview(target)) ?? "";
      let previousBlock = 0;
      let followBlock = 0;
      let previousIndex = sameNoteBlocks.findIndex(
        (block) => block.blockId === target.blockId,
      );
      let followIndex = previousIndex;

      while (!(
        previewText.length > TARGET_PREVIEW_CHARACTER || // stop if preview text reaches the limit
        ((previousBlock >= TARGET_PREVIOUS_BLOCK || previousIndex < 0) &&
          (followBlock >= TARGET_FOLLOW_BLOCK ||
            followIndex >= sameNoteBlocks.length)) // stop if no more blocks, or preview block reaches the limit
      )) {
        if (previousBlock < TARGET_PREVIOUS_BLOCK) {
          previousIndex--;
          const block =
            previousIndex >= 0 ? sameNoteBlocks.at(previousIndex) : null;
          const markdown = block ? await generateMarkdownPreview(block) : null;
          if (
            markdown &&
            !previewText.startsWith(
              markdown,
            ) /* A small hack to skip blocks with the same content */
          ) {
            previewText = markdown + "\n" + previewText;
            previousBlock++;
          }
        }

        if (followBlock < TARGET_FOLLOW_BLOCK) {
          followIndex++;
          const block = sameNoteBlocks.at(followIndex);
          const markdown = block ? await generateMarkdownPreview(block) : null;
          if (
            markdown &&
            !previewText.endsWith(
              markdown,
            ) /* A small hack to skip blocks with the same content */
          ) {
            previewText = previewText + "\n" + markdown;
            followBlock++;
          }
        }
      }

      block.markdownPreview = unindentMarkdown(previewText);
    }
  }
  // #endregion

  return {
    blocks: blockDocuments,
    title: docTitle,
    summary,
  };
}

/**
 * Get all docs from the root doc
 */
export function readAllDocsFromRootDoc(
  rootDoc: YDoc,
  options?: {
    includeTrash?: boolean;
  },
) {
  const docs = rootDoc.getMap("meta").get("pages") as
    YArray<YMap<any>> | undefined;
  const availableDocs = new Map<string, { title: string | undefined }>();

  if (docs) {
    for (const page of docs) {
      const docId = page.get("id");

      if (typeof docId !== "string") {
        continue;
      }

      const inTrash = page.get("trash") ?? false;
      const title = page.get("title");

      if (!options?.includeTrash && inTrash) {
        continue;
      }

      availableDocs.set(docId, { title });
    }
  }

  return availableDocs;
}

export function readAllDocIdsFromRootDoc(
  rootDoc: YDoc,
  options?: {
    includeTrash?: boolean;
  },
) {
  const docs = rootDoc.getMap("meta").get("pages") as
    YArray<YMap<any>> | undefined;
  const docIds = new Set<string>();
  if (docs) {
    for (const page of docs) {
      const docId = page.get("id");
      if (typeof docId !== "string") {
        continue;
      }
      const inTrash = page.get("trash") ?? false;
      if (!options?.includeTrash && inTrash) {
        continue;
      }
      docIds.add(docId);
    }
  }
  return Array.from(docIds);
}

export { parseBlock, parseBlockToMd, parsePageDoc } from "./doc-parser/parser";
