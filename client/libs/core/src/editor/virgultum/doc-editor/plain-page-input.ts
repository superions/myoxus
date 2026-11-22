// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
import * as Y from "yjs";
import type { PageLine } from "./plain-page-model";
import { expandAnnotationSelection } from "@virgultum/core/models/annotation";

type Point = { id: string; offset: number };
export type PageRange = { anchor: Point; focus: Point };
type RelativePoint = { id: string; position: Y.RelativePosition };
export type PageBookmark = { anchor: RelativePoint; focus: RelativePoint };
export type PageIntent =
  | {
      kind: "comment-thread";
      block: string;
      id: string;
      point: Y.RelativePosition;
    }
  | {
      kind: "link-command";
      url: string;
      action: "open" | "convert";
      button: number;
    }
  | {
      kind: "table-cell";
      id: string;
      row: string;
      column: string;
      from: Y.RelativePosition;
      to: Y.RelativePosition;
      menu?: "cell" | "row";
      paste?: DataTransfer;
    }
  | {
      kind: "block-command";
      id: string;
      flavour?: string;
      control?: string;
      clipboard?: "copy" | "cut" | "paste";
      data?: DataTransfer;
    }
  | { kind: "range-clipboard"; action: "copy" | "cut" }
  | { kind: "block-paste"; id: string; data: DataTransfer }
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
  if (!field.querySelector("[data-page-inline-length]"))
    return { id: field.dataset.pageText!, offset: r.toString().length };
  // A reference title or annotation button is view text. Its caret extent is
  // the original attributed run, independent of its current localized label.
  const surface = (
    node instanceof Element ? node : node.parentElement
  )?.closest<HTMLElement>("[data-page-inline-length]");
  if (surface) r.setEndBefore(surface);
  const fragment = r.cloneContents();
  for (const marker of fragment.querySelectorAll<HTMLElement>(
    "[data-page-inline-length]",
  ))
    marker.replaceWith(
      document.createTextNode(
        " ".repeat(Number(marker.dataset.pageInlineLength)),
      ),
    );
  return { id: field.dataset.pageText!, offset: fragment.textContent.length };
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
    const it = document.createTreeWalker(
      field,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          const el = node instanceof Element ? node : node.parentElement;
          if (
            el?.parentElement?.closest("[data-page-inline-length]") ||
            (node.nodeType === Node.TEXT_NODE &&
              el?.closest("[data-page-inline-length]"))
          )
            return NodeFilter.FILTER_REJECT;
          return node.nodeType === Node.TEXT_NODE ||
            el?.hasAttribute("data-page-inline-length")
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      },
    );
    for (let node = it.nextNode(); node; node = it.nextNode()) {
      if (node instanceof HTMLElement) {
        const n = Number(node.dataset.pageInlineLength);
        if (left <= n)
          return [
            node.parentNode!,
            Array.prototype.indexOf.call(node.parentNode!.childNodes, node) +
              (left ? 1 : 0),
          ];
        left -= n;
        continue;
      }
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
  return lines.slice(Math.min(a, b), Math.max(a, b) + 1).map((line) => {
    const from = line.model.id === start.id ? start.offset : 0,
      to = line.model.id === end.id ? end.offset : line.text.length;
    const range = expandAnnotationSelection(
      line.text.toDelta(),
      from,
      to - from,
    );
    return { line, from: range.index, to: range.index + range.length };
  });
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
    parts.some(
      (p) =>
        p.line.heading &&
        (p.line.model.props as { collapsed?: boolean }).collapsed,
    )
  )
    return null;
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
  if (pieces.length > 1 && parts.some((p) => p.line.heading)) return null;
  // Splitting the callout's own text is a structural callout command; never
  // clone the hub as though it were an ordinary sibling paragraph.
  if (
    (parts.length > 1 || pieces.length > 1) &&
    parts.some((p) => p.line.model.flavour === "myoxus:callout")
  )
    return null;
  const title = first.line.kind === "title";
  const parent = title
    ? page.root?.children.find((m) => m.flavour === "myoxus:note")
    : first.line.model.parent;
  // Rich references have their own removal and clipboard commands. A text
  // replacement across one must be replayed by that command owner.
  const covered =
    parent && parts.length > 1
      ? parent.children.slice(
          parent.children.indexOf(first.line.model) + 1,
          parent.children.indexOf(last.line.model) + 1,
        )
      : [];
  if (
    covered.some(
      (block) =>
        (block.text && !lines.some((l) => l.model === block)) ||
        !["myoxus:divider", "myoxus:list", "myoxus:paragraph"].includes(
          block.flavour,
        ),
    )
  )
    return null;
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
    if (parts.length > 1 && parent) {
      // Text endpoints can enclose atomic blocks. Delete the actual siblings,
      // not just their editable projection, in the same undo transaction.
      for (const block of covered) page.deleteBlock(block);
    }
    if (pieces[0]) {
      // A typed character next to a marker must not inherit its native identity.
      let pos = 0;
      const prev =
        first.from &&
        (target.toDelta() as Run[]).find(
          (op) => (pos += op.insert.length) >= first.from,
        );
      target.insert(
        first.from,
        pieces[0],
        prev &&
          (prev.attributes?.annotation ||
            prev.attributes?.reference ||
            prev.attributes?.footnote ||
            prev.attributes?.mention ||
            prev.attributes?.documentField ||
            typeof prev.attributes?.latex === "string")
          ? (marks ?? {})
          : marks,
      );
    }
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
