// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

export type Block = {
  id: string;
  type: string;
  content: string;
};

export type PatchOp =
  | { op: "replace"; id: string; content: string }
  | { op: "delete"; id: string }
  | { op: "insert"; index: number; after: string; block: Block };

const BLOCK_HEADER_PATTERN = /^\s*<!--\s*block_id=(.*?)\s+flavour=(.*?)\s*-->/;

export function parseMarkdownToBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let activeId: string | null = null;
  let activeType: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (activeId && activeType) {
      blocks.push({
        id: activeId,
        type: activeType,
        content: buffer.join("\n").trim(),
      });
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    const header = line.match(BLOCK_HEADER_PATTERN);
    if (header) {
      flush();
      activeId = header[1];
      activeType = header[2];
      buffer = [];
    } else if (activeId && activeType) {
      buffer.push(line);
    }
  }
  flush();

  return blocks;
}

function computeBlockPatches(
  previousBlocks: Block[],
  nextBlocks: Block[],
): PatchOp[] {
  const ops: PatchOp[] = [];
  const previousById = new Map(previousBlocks.map((b) => [b.id, b]));
  const nextIds = new Set(nextBlocks.map((b) => b.id));

  for (let i = 0; i < nextBlocks.length; i++) {
    const next = nextBlocks[i];
    const prev = previousById.get(next.id);
    if (prev) {
      if (prev.content !== next.content) {
        ops.push({ op: "replace", id: next.id, content: next.content });
      }
    } else {
      ops.push({
        op: "insert",
        index: i,
        after: i > 0 ? nextBlocks[i - 1].id : "HEAD",
        block: { id: next.id, type: next.type, content: next.content },
      });
    }
  }

  for (const prev of previousBlocks) {
    if (!nextIds.has(prev.id)) {
      ops.push({ op: "delete", id: prev.id });
    }
  }

  return ops;
}

export function diffMarkdown(oldMarkdown: string, newMarkdown: string) {
  const oldBlocks = parseMarkdownToBlocks(oldMarkdown);
  const newBlocks = parseMarkdownToBlocks(newMarkdown);
  const patches = computeBlockPatches(oldBlocks, newBlocks);
  return { patches, newBlocks, oldBlocks };
}
