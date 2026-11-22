// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
import * as Y from "yjs";
import type { PageLine } from "./plain-page-model";

type Point = { id: string; offset: number };
export type PageRange = { anchor: Point; focus: Point };
type RelativePoint = { id: string; position: Y.RelativePosition };
export type PageBookmark = { anchor: RelativePoint; focus: RelativePoint };
export type PageIntent =
  | { kind: "slash"; trigger: string; start: PageBookmark }
  | { kind: "paste"; data: DataTransfer }
  | { kind: "input"; inputType: string; data: string | null }
  | {
      kind: "key";
      key: string;
      code: string;
      shiftKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
    }
  | { kind: "selection"; control?: string };

function pointAt(
  root: HTMLElement,
  node: Node | null,
  offset: number,
): Point | null {
  if (!node || !root.contains(node)) return null;
  const field = (
    node instanceof Element ? node : node.parentElement
  )?.closest<HTMLElement>("[data-page-text]");
  if (!field) {
    // Chromium places a caret in the parent div of a sole <br> or an
    // inline span clicked in its trailing whitespace.
    const row = (node instanceof Element ? node : node.parentElement)?.closest(
      ".plain-page-line",
    );
    const line = row?.querySelector<HTMLElement>("[data-page-text]");
    if (!line || !row) return null;
    const r = document.createRange();
    r.selectNodeContents(row);
    r.setEnd(node, offset);
    return {
      id: line.dataset.pageText!,
      offset: r.comparePoint(line, 0) > 0 ? 0 : (line.textContent?.length ?? 0),
    };
  }
  const r = document.createRange();
  r.selectNodeContents(field);
  r.setEnd(node, offset);
  return { id: field.dataset.pageText!, offset: r.toString().length };
}
export function readPageRange(root: HTMLElement): PageRange | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel) return null;
  const anchor = pointAt(root, sel.anchorNode, sel.anchorOffset),
    focus = pointAt(root, sel.focusNode, sel.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}
export function inputTarget(root: HTMLElement, e: InputEvent) {
  const r = e.getTargetRanges()[0];
  if (!r) return null;
  const anchor = pointAt(root, r.startContainer, r.startOffset),
    focus = pointAt(root, r.endContainer, r.endOffset);
  return anchor && focus ? { anchor, focus } : null;
}
export function bookmark(
  lines: PageLine[],
  range: PageRange,
): PageBookmark | null {
  const to = (p: Point) => {
    const line = lines.find((l) => l.model.id === p.id);
    return line
      ? {
          id: p.id,
          position: Y.createRelativePositionFromTypeIndex(
            line.text,
            Math.min(line.text.length, p.offset),
            -1,
          ),
        }
      : null;
  };
  const anchor = to(range.anchor),
    focus = to(range.focus);
  return anchor && focus ? { anchor, focus } : null;
}
export function resolveBookmark(
  page: Store,
  s: PageBookmark,
): PageRange | null {
  const to = (p: RelativePoint) => {
    const pos = Y.createAbsolutePositionFromRelativePosition(
      p.position,
      page.spaceDoc,
    );
    const model = page.getBlock(p.id)?.model;
    const text =
      model?.text?.yText ??
      (model?.props as { title?: { yText: Y.Text } } | undefined)?.title?.yText;
    return pos && text === pos.type ? { id: p.id, offset: pos.index } : null;
  };
  const anchor = to(s.anchor),
    focus = to(s.focus);
  return anchor && focus ? { anchor, focus } : null;
}
export function restorePageRange(root: HTMLElement, s: PageRange) {
  const to = (p: Point): [Node, number] | null => {
    const field = root.querySelector<HTMLElement>(
      `[data-page-text="${CSS.escape(p.id)}"]`,
    );
    if (!field) return null;
    let left = p.offset;
    const it = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    for (let node = it.nextNode(); node; node = it.nextNode()) {
      const n = node.textContent!.length;
      if (left <= n) return [node, left];
      left -= n;
    }
    return [field, field.childNodes.length];
  };
  const a = to(s.anchor),
    b = to(s.focus);
  const selection = root.ownerDocument.getSelection();
  if (
    a &&
    b &&
    selection &&
    (selection.anchorNode !== a[0] ||
      selection.anchorOffset !== a[1] ||
      selection.focusNode !== b[0] ||
      selection.focusOffset !== b[1])
  )
    selection.setBaseAndExtent(...a, ...b);
}

export function segments(lines: PageLine[], s: PageRange) {
  const a = lines.findIndex((l) => l.model.id === s.anchor.id),
    b = lines.findIndex((l) => l.model.id === s.focus.id);
  if (a < 0 || b < 0) return [];
  const reverse = a > b || (a === b && s.anchor.offset > s.focus.offset);
  const [start, end] = reverse ? [s.focus, s.anchor] : [s.anchor, s.focus];
  return lines.slice(Math.min(a, b), Math.max(a, b) + 1).map((line) => ({
    line,
    from: line.model.id === start.id ? start.offset : 0,
    to: line.model.id === end.id ? end.offset : line.text.length,
  }));
}
type Run = { insert: string; attributes?: Record<string, unknown> };
function tail(text: Y.Text, offset: number): Run[] {
  return (text.toDelta() as Run[]).flatMap((run) => {
    const start = Math.min(offset, run.insert.length);
    offset -= start;
    return start < run.insert.length
      ? [{ ...run, insert: run.insert.slice(start) }]
      : [];
  });
}
const collapsed = (p: Point): PageRange => ({ anchor: p, focus: p });
/** A command owns one Store transaction. The view never replaces a Y.Text or
 * replays a DOM snapshot over a concurrently edited model. */
export function replacePageRange(
  page: Store,
  lines: PageLine[],
  s: PageRange,
  value: string,
  marks?: Record<string, unknown>,
): PageRange | null {
  const parts = segments(lines, s),
    first = parts[0],
    last = parts.at(-1);
  if (page.readonly || !first || !last) return null;
  if (
    parts.length > 1 &&
    (first.line.kind === "title" ||
      parts.some(
        (p) =>
          p.line.model.parent !== first.line.model.parent ||
          p.line.model.children.length,
      ))
  )
    return null;
  if (parts.some((p) => page.hasFixedText(p.line.model))) return null;
  const pieces = value.replaceAll("\r\n", "\n").split("\n");
  const title = first.line.kind === "title";
  const parent = title ? lines[1]?.model.parent : first.line.model.parent;
  if (
    pieces.length > 1 &&
    (!parent || (!title && first.line.model.children.length))
  )
    return null;
  let caret: Point = { id: first.line.model.id, offset: first.from };
  page.transact(() => {
    const join = parts.length > 1 || pieces.length > 1;
    const suffix = join ? tail(last.line.text, last.to) : [];
    const target = first.line.text;
    target.delete(first.from, (join ? target.length : first.to) - first.from);
    for (const p of parts.slice(1)) page.deleteBlock(p.line.model);
    if (pieces[0]) target.insert(first.from, pieces[0], marks);
    caret.offset += pieces[0].length;
    let dest = target;
    if (pieces.length > 1 && parent) {
      const index = title
        ? -1
        : parent.children.findIndex((m) => m.id === first.line.model.id);
      for (const [i, piece] of pieces.slice(1).entries()) {
        const id = page.addBlock(
          title ? "myoxus:paragraph" : first.line.model.flavour,
          { type: title ? "text" : first.line.kind },
          parent,
          index + i + 1,
        );
        // Store models are published after the transaction; the newly attached
        // shared type already exists inside this atomic split.
        dest = page.doc.yBlocks.get(id)!.get("prop:text") as Y.Text;
        if (piece) dest.insert(0, piece, marks);
        caret = { id, offset: piece.length };
      }
    }
    let at = caret.offset;
    for (const run of suffix) {
      dest.insert(at, run.insert, run.attributes ?? {});
      at += run.insert.length;
    }
  });
  return collapsed(caret);
}
export function deletionRange(
  lines: PageLine[],
  range: PageRange,
  back: boolean,
): PageRange {
  const { anchor, focus } = range;
  if (anchor.id !== focus.id || anchor.offset !== focus.offset) return range;
  const index = lines.findIndex((l) => l.model.id === anchor.id),
    line = lines[index];
  if (!line) return range;
  const text = line.text.toString(),
    i = anchor.offset;
  if ((back && i > 0) || (!back && i < text.length)) {
    const slice = back ? text.slice(0, i) : text.slice(i);
    const groups = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(slice);
    const length = groups.containing(back ? slice.length - 1 : 0)!.segment
      .length;
    return {
      anchor,
      focus: { id: anchor.id, offset: i + (back ? -length : length) },
    };
  }
  const other = lines[index + (back ? -1 : 1)];
  return other && line.kind !== "title" && other.kind !== "title"
    ? {
        anchor,
        focus: { id: other.model.id, offset: back ? other.text.length : 0 },
      }
    : range;
}
