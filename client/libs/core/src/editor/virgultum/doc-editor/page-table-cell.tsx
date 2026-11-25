// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ReferenceInfo, TableBlockModel } from "@virgultum/core/models";
import { setInlineStyles } from "@virgultum/core/runtime/inline/attributes";
import { documentFieldTextStyles } from "@virgultum/core/styles/text";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { isValidUrl, normalizeUrl } from "@virgultum/core/utils/url";
import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import * as Y from "yjs";

import type { PageInlineObject } from "./page-inline-object";
import type { PageLine } from "./plain-page-model";
import { pageTextRun } from "./page-text-run";

const InlineObject = lazy(() => import("./page-inline-object"));

export const CELL_DELTA_MIME = "application/x-myoxus-cell-delta";

const INHERITED_MARKS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "color",
  "background",
  "labelTone",
] as const;

export type DeltaOp = {
  insert: string;
  attributes?: MyoxusTextAttributes;
};

/** Slice delta runs covering `[index, index + length)` from any Y.Text. */
export function sliceYTextDelta(
  text: Y.Text,
  index: number,
  length: number,
): DeltaOp[] {
  if (length <= 0) return [];
  const end = index + length;
  const ops = text.toDelta() as {
    insert: unknown;
    attributes?: MyoxusTextAttributes;
  }[];
  const result: DeltaOp[] = [];
  let pos = 0;
  for (const op of ops) {
    if (typeof op.insert !== "string") continue;
    const opEnd = pos + op.insert.length;
    if (opEnd > index && pos < end) {
      const from = Math.max(0, index - pos);
      const to = Math.min(op.insert.length, end - pos);
      result.push({
        insert: op.insert.slice(from, to),
        ...(op.attributes ? { attributes: { ...op.attributes } } : {}),
      });
    }
    pos = opEnd;
    if (pos >= end) break;
  }
  return result;
}

function pointOffsetInCell(
  cellEl: HTMLElement,
  node: Node | null,
  offset: number,
): number | null {
  if (!node || !cellEl.contains(node)) return null;
  const range = cellEl.ownerDocument.createRange();
  range.selectNodeContents(cellEl);
  const surface = (
    node instanceof Element ? node : node.parentElement
  )?.closest<HTMLElement>("[data-page-inline-length]");
  if (surface && cellEl.contains(surface)) {
    range.setEndBefore(surface);
  } else {
    range.setEnd(node, offset);
  }
  if (!cellEl.querySelector("[data-page-inline-length]")) {
    return range.toString().length;
  }
  const fragment = range.cloneContents();
  for (const marker of fragment.querySelectorAll<HTMLElement>(
    "[data-page-inline-length]",
  )) {
    marker.replaceWith(
      cellEl.ownerDocument.createTextNode(
        " ".repeat(Number(marker.dataset.pageInlineLength) || 1),
      ),
    );
  }
  return fragment.textContent.length;
}

export function readCellSelection(
  cellEl: HTMLElement,
): { start: number; end: number } | null {
  const sel = cellEl.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const a = pointOffsetInCell(cellEl, sel.anchorNode, sel.anchorOffset);
  const b = pointOffsetInCell(cellEl, sel.focusNode, sel.focusOffset);
  if (a === null || b === null) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function resolveCellDomPoint(
  cellEl: HTMLElement,
  targetOffset: number,
): [Node, number] {
  let left = Math.max(0, targetOffset);
  const doc = cellEl.ownerDocument;
  const walker = doc.createTreeWalker(
    cellEl,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (n) => {
        if (n instanceof HTMLElement && n.dataset.pageInlineLength) {
          return NodeFilter.FILTER_ACCEPT;
        }
        if (
          n.nodeType === Node.TEXT_NODE &&
          !n.parentElement?.closest("[data-page-inline-length]")
        ) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    },
  );
  let last: [Node, number] = [cellEl, 0];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof HTMLElement && current.dataset.pageInlineLength) {
      const len = Number(current.dataset.pageInlineLength) || 1;
      const parent = current.parentNode!;
      const idx = Array.prototype.indexOf.call(parent.childNodes, current);
      if (left <= 0) return [parent, idx];
      if (left <= len) return [parent, idx + 1];
      left -= len;
      last = [parent, idx + 1];
    } else if (current.nodeType === Node.TEXT_NODE) {
      const len = current.textContent?.length ?? 0;
      if (left <= len) return [current, left];
      left -= len;
      last = [current, len];
    }
    current = walker.nextNode();
  }
  return last;
}

export function restoreCellSelection(
  cellEl: HTMLElement,
  start: number,
  end = start,
) {
  const sel = cellEl.ownerDocument.getSelection();
  if (!sel) return;
  const [startNode, startOff] = resolveCellDomPoint(cellEl, start);
  const [endNode, endOff] =
    end === start ? [startNode, startOff] : resolveCellDomPoint(cellEl, end);
  const range = cellEl.ownerDocument.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  sel.removeAllRanges();
  sel.addRange(range);
}

function inheritedAttributesAt(
  text: Y.Text,
  index: number,
): Record<string, unknown> | undefined {
  if (index <= 0) return undefined;
  const prev = sliceYTextDelta(text, index - 1, 1)[0];
  if (!prev?.attributes) return undefined;
  const picked: Record<string, unknown> = {};
  for (const mark of INHERITED_MARKS) {
    const val = (prev.attributes as Record<string, unknown>)[mark];
    if (val !== undefined && val !== null && val !== false) {
      picked[mark] = val;
    }
  }
  return Object.keys(picked).length ? picked : undefined;
}

export function toggleCellFormat(
  model: TableBlockModel,
  text: Y.Text,
  start: number,
  end: number,
  mark: "bold" | "italic" | "underline" | "strike" | "code",
) {
  if (end <= start || model.store.readonly) return;
  const slice = sliceYTextDelta(text, start, end - start);
  const allActive =
    slice.length > 0 &&
    slice.every((op) =>
      Boolean((op.attributes as Record<string, unknown>)?.[mark]),
    );
  model.store.captureSync();
  model.store.transact(() => {
    text.format(start, end - start, { [mark]: allActive ? null : true });
  });
  model.store.captureSync();
}

export function clearCellFormatting(
  model: TableBlockModel,
  text: Y.Text,
  start: number,
  end: number,
) {
  if (end <= start || model.store.readonly) return;
  model.store.captureSync();
  model.store.transact(() => {
    text.format(start, end - start, {
      bold: null,
      italic: null,
      underline: null,
      strike: null,
      code: null,
      color: null,
      background: null,
      labelTone: null,
    });
  });
  model.store.captureSync();
}

export interface CellSelectionSnapshot {
  row: string;
  column: string;
  start: number;
  end: number;
  rect: DOMRect;
  text: Y.Text;
}

export function PageTableCell({
  model,
  text,
  row,
  column,
  readonly,
  textProtection,
  onOpenLink,
  onRichSelectionChange,
  onFocusCell,
}: {
  model: TableBlockModel;
  text: Y.Text;
  row: string;
  column: string;
  readonly: boolean;
  textProtection?: "source" | "fixed";
  onOpenLink?: (url: string, button: number) => void;
  onRichSelectionChange?: (selection: CellSelectionSnapshot | null) => void;
  onFocusCell?: (row: string, column: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previousPaint = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const compositionAnchor = useRef<
    [Y.RelativePosition, Y.RelativePosition] | null
  >(null);
  const pendingSelection = useRef<
    [Y.RelativePosition, Y.RelativePosition] | null
  >(null);
  const [objects, setObjects] = useState<
    { el: HTMLElement; object: PageInlineObject; key: string }[]
  >([]);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const callbacksRef = useRef({
    onOpenLink,
    onRichSelectionChange,
    onFocusCell,
  });
  callbacksRef.current = {
    onOpenLink,
    onRichSelectionChange,
    onFocusCell,
  };

  const fixed = textProtection === "fixed";
  const canEdit = !readonly && !fixed && !model.store.readonly;

  const line = useMemo<PageLine>(
    () => ({
      kind: "text",
      model,
      text,
      depth: 0,
      ordinal: 0,
      checked: false,
    }),
    [model, text],
  );

  const attached = () =>
    model.store.getModelById(model.id) === model &&
    model.props.cells[`${row}:${column}`]?.text.yText === text;

  const paintCell = () => {
    const field = ref.current;
    if (!field || composing.current) return;
    const runs = text.toDelta() as DeltaOp[];
    const key = JSON.stringify([canEdit, runs]);
    if (previousPaint.current !== key) {
      previousPaint.current = key;
      const doc = field.ownerDocument;
      const fragment = doc.createDocumentFragment();
      const next: typeof objects = [];
      let offset = 0;

      for (let i = 0; i < runs.length; i++) {
        const { insert, attributes: a = {} } = runs[i];
        if (typeof insert !== "string") continue;
        const start = offset;
        offset += insert.length;

        if (
          a.reference ||
          a.documentField ||
          a.annotation ||
          a.footnote ||
          a.mention ||
          typeof a.latex === "string"
        ) {
          const position = Y.createRelativePositionFromTypeIndex(
            text,
            start,
            0,
          );
          const objKey = JSON.stringify(position);
          const el =
            objectsRef.current.find((o) => o.key === objKey)?.el ??
            doc.createElement("span");
          let object: PageInlineObject;
          if (a.documentField) {
            object = {
              kind: "field",
              value:
                a.documentField as import("@virgultum/core/types").DocumentField,
              start: position,
            };
          } else if (typeof a.latex === "string") {
            object = { kind: "latex", source: a.latex, start: position };
          } else if (a.mention) {
            object = {
              kind: "mention",
              member: (a.mention as { member: string }).member,
            };
          } else if (a.footnote) {
            const value =
              a.footnote as import("@virgultum/core/models").FootNote;
            object =
              value.definitionId === undefined
                ? { kind: "citation", value, start: position }
                : {
                    kind: "footnote",
                    id: value.definitionId,
                    start: position,
                  };
          } else if (a.reference) {
            object = {
              kind: "reference",
              reference: a.reference as ReferenceInfo,
            };
          } else {
            const id = (a.annotation as { id: string }).id;
            let body = insert;
            while (
              (
                runs[i + 1]?.attributes?.annotation as
                  { id: string } | undefined
              )?.id === id
            ) {
              body += runs[++i].insert;
              offset += runs[i].insert.length;
            }
            object = { kind: "annotation", id, body, start: position };
          }
          setInlineStyles(
            el,
            a.documentField ? documentFieldTextStyles(a) : {},
          );
          el.contentEditable = "false";
          el.dataset.pageInlineLength = String(offset - start);
          el.dataset.pageInline = object.kind;
          next.push({ el, object, key: objKey });
          fragment.append(el);
          continue;
        }

        let node = pageTextRun(doc, insert, a as Record<string, unknown>);
        if (typeof a.link === "string") {
          const url = normalizeUrl(a.link);
          if (url && isValidUrl(url)) {
            const anchor = doc.createElement("a");
            anchor.dataset.pageLink = "";
            anchor.href = url;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.append(node);
            anchor.onclick = anchor.onauxclick = (event) => {
              if (!doc.getSelection()?.isCollapsed || event.button > 1) return;
              event.preventDefault();
              if (callbacksRef.current.onOpenLink)
                callbacksRef.current.onOpenLink(url, event.button);
              else window.open(url, "_blank", "noopener,noreferrer");
            };
            node = anchor;
          }
        }
        fragment.append(node);
      }

      if (!runs.length) {
        fragment.append(doc.createElement("br"));
      }
      field.replaceChildren(fragment);
      if (next.length || objectsRef.current.length) setObjects(next);
    }

    if (pendingSelection.current && document.activeElement === field) {
      const [relA, relB] = pendingSelection.current;
      pendingSelection.current = null;
      const absA = Y.createAbsolutePositionFromRelativePosition(
        relA,
        model.store.spaceDoc,
      );
      const absB = Y.createAbsolutePositionFromRelativePosition(
        relB,
        model.store.spaceDoc,
      );
      if (absA && absB && absA.type === text && absB.type === text) {
        restoreCellSelection(field, absA.index, absB.index);
      }
    }
  };

  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const store = model.store;
    const doc = store.spaceDoc;

    const rememberSelection = () => {
      if (composing.current || document.activeElement !== field) return;
      const sel = readCellSelection(field);
      if (!sel) return;
      pendingSelection.current = [
        Y.createRelativePositionFromTypeIndex(
          text,
          Math.min(text.length, sel.start),
          -1,
        ),
        Y.createRelativePositionFromTypeIndex(
          text,
          Math.min(text.length, sel.end),
          -1,
        ),
      ];
    };

    const writeDelta = (
      start: number,
      end: number,
      value: string,
      attrs?: Record<string, unknown>,
    ) => {
      if (!canEdit || !attached()) return;
      const safeStart = Math.max(0, Math.min(text.length, start));
      const safeEnd = Math.max(safeStart, Math.min(text.length, end));
      const nextAttrs = attrs ?? inheritedAttributesAt(text, safeStart);
      store.transact(() => {
        if (safeEnd > safeStart) text.delete(safeStart, safeEnd - safeStart);
        if (value) text.insert(safeStart, value, nextAttrs);
      });
      const caret = safeStart + value.length;
      pendingSelection.current = [
        Y.createRelativePositionFromTypeIndex(text, caret, -1),
        Y.createRelativePositionFromTypeIndex(text, caret, -1),
      ];
      paintCell();
    };

    const onBeforeInput = (e: InputEvent) => {
      if (composing.current) return;
      if (!canEdit) {
        e.preventDefault();
        return;
      }
      const targetRange = e.getTargetRanges()[0];
      const range =
        (targetRange
          ? (() => {
              const a = pointOffsetInCell(
                field,
                targetRange.startContainer,
                targetRange.startOffset,
              );
              const b = pointOffsetInCell(
                field,
                targetRange.endContainer,
                targetRange.endOffset,
              );
              return a !== null && b !== null
                ? { start: Math.min(a, b), end: Math.max(a, b) }
                : null;
            })()
          : null) ?? readCellSelection(field);

      if (!range) return;

      switch (e.inputType) {
        case "insertText":
        case "insertReplacementText":
          e.preventDefault();
          writeDelta(range.start, range.end, e.data ?? "");
          return;
        case "insertParagraph":
        case "insertLineBreak":
          e.preventDefault();
          store.captureSync();
          writeDelta(range.start, range.end, "\n");
          store.captureSync();
          return;
        case "deleteContentBackward": {
          e.preventDefault();
          let delStart = range.start;
          if (range.start === range.end && range.start > 0) {
            const raw = text.toString();
            const segmenter =
              typeof Intl !== "undefined" && "Segmenter" in Intl
                ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
                : null;
            if (segmenter) {
              let prev = 0;
              for (const seg of segmenter.segment(raw.slice(0, range.start))) {
                prev = seg.index;
              }
              delStart = prev;
            } else {
              delStart = Math.max(0, range.start - 1);
            }
          }
          store.captureSync();
          writeDelta(delStart, range.end, "");
          store.captureSync();
          return;
        }
        case "deleteContentForward": {
          e.preventDefault();
          let delEnd = range.end;
          if (range.start === range.end && range.end < text.length) {
            const raw = text.toString();
            const segmenter =
              typeof Intl !== "undefined" && "Segmenter" in Intl
                ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
                : null;
            if (segmenter) {
              const firstSeg = segmenter
                .segment(raw.slice(range.end))
                [Symbol.iterator]()
                .next().value;
              delEnd = firstSeg
                ? Math.min(text.length, range.end + firstSeg.segment.length)
                : Math.min(text.length, range.end + 1);
            } else {
              delEnd = Math.min(text.length, range.end + 1);
            }
          }
          store.captureSync();
          writeDelta(range.start, delEnd, "");
          store.captureSync();
          return;
        }
        case "deleteWordBackward":
        case "deleteWordForward":
        case "deleteSoftLineBackward":
        case "deleteSoftLineForward":
        case "deleteHardLineBackward":
        case "deleteHardLineForward":
        case "deleteByCut":
          e.preventDefault();
          store.captureSync();
          writeDelta(range.start, range.end, "");
          store.captureSync();
          return;
        case "historyUndo":
          e.preventDefault();
          store.undo();
          return;
        case "historyRedo":
          e.preventDefault();
          store.redo();
          return;
        case "formatBold":
        case "formatItalic":
        case "formatUnderline":
        case "formatStrikeThrough": {
          e.preventDefault();
          const map = {
            formatBold: "bold",
            formatItalic: "italic",
            formatUnderline: "underline",
            formatStrikeThrough: "strike",
          } as const;
          toggleCellFormat(
            model,
            text,
            range.start,
            range.end,
            map[e.inputType],
          );
          pendingSelection.current = [
            Y.createRelativePositionFromTypeIndex(text, range.start, -1),
            Y.createRelativePositionFromTypeIndex(text, range.end, -1),
          ];
          paintCell();
          return;
        }
        default:
          e.preventDefault();
      }
    };

    const onCompositionStart = () => {
      if (!canEdit) return;
      composing.current = true;
      const sel = readCellSelection(field) ?? {
        start: text.length,
        end: text.length,
      };
      compositionAnchor.current = [
        Y.createRelativePositionFromTypeIndex(
          text,
          Math.min(text.length, sel.start),
          -1,
        ),
        Y.createRelativePositionFromTypeIndex(
          text,
          Math.min(text.length, sel.end),
          -1,
        ),
      ];
    };

    const onCompositionEnd = (e: CompositionEvent) => {
      if (!composing.current) return;
      composing.current = false;
      const anchor = compositionAnchor.current;
      compositionAnchor.current = null;
      previousPaint.current = undefined;
      if (anchor && canEdit && attached()) {
        const absA = Y.createAbsolutePositionFromRelativePosition(
          anchor[0],
          doc,
        );
        const absB = Y.createAbsolutePositionFromRelativePosition(
          anchor[1],
          doc,
        );
        if (absA && absB && absA.type === text && absB.type === text) {
          store.captureSync();
          writeDelta(absA.index, absB.index, e.data ?? "");
          store.captureSync();
          return;
        }
      }
      paintCell();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === "a") {
          e.preventDefault();
          e.stopPropagation();
          restoreCellSelection(field, 0, text.length);
          emitSelection();
          return;
        }
        if (!canEdit) return;
        const sel = readCellSelection(field);
        if (sel && sel.end > sel.start) {
          const mark =
            key === "b"
              ? "bold"
              : key === "i"
                ? "italic"
                : key === "u"
                  ? "underline"
                  : key === "e"
                    ? "code"
                    : key === "s" && e.shiftKey
                      ? "strike"
                      : null;
          if (mark) {
            e.preventDefault();
            e.stopPropagation();
            toggleCellFormat(model, text, sel.start, sel.end, mark);
            pendingSelection.current = [
              Y.createRelativePositionFromTypeIndex(text, sel.start, -1),
              Y.createRelativePositionFromTypeIndex(text, sel.end, -1),
            ];
            paintCell();
          }
        }
      }
    };

    const onCopyOrCut = (e: ClipboardEvent, isCut: boolean) => {
      const sel = readCellSelection(field);
      if (!sel || sel.end <= sel.start) return;
      const ops = sliceYTextDelta(text, sel.start, sel.end - sel.start);
      if (!ops.length) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData(
        "text/plain",
        ops.map((op) => op.insert).join(""),
      );
      e.clipboardData?.setData(CELL_DELTA_MIME, JSON.stringify(ops));
      if (isCut && canEdit && attached()) {
        store.captureSync();
        writeDelta(sel.start, sel.end, "");
        store.captureSync();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!canEdit || !attached()) return;
      const sel = readCellSelection(field);
      if (!sel) return;
      const deltaJson = e.clipboardData?.getData(CELL_DELTA_MIME);
      if (deltaJson) {
        try {
          const ops = JSON.parse(deltaJson) as DeltaOp[];
          if (Array.isArray(ops)) {
            e.preventDefault();
            e.stopPropagation();
            store.captureSync();
            store.transact(() => {
              if (sel.end > sel.start)
                text.delete(sel.start, sel.end - sel.start);
              let cursor = sel.start;
              for (const op of ops) {
                if (typeof op.insert !== "string" || !op.insert.length)
                  continue;
                text.insert(cursor, op.insert, op.attributes);
                cursor += op.insert.length;
              }
              pendingSelection.current = [
                Y.createRelativePositionFromTypeIndex(text, cursor, -1),
                Y.createRelativePositionFromTypeIndex(text, cursor, -1),
              ];
            });
            store.captureSync();
            paintCell();
            return;
          }
        } catch {
          /* Fall through to plain-text paste. */
        }
      }
      const plain = e.clipboardData?.getData("text/plain");
      if (plain !== undefined && !plain.includes("\t")) {
        e.preventDefault();
        e.stopPropagation();
        store.captureSync();
        writeDelta(sel.start, sel.end, plain);
        store.captureSync();
      }
    };

    const emitSelection = () => {
      if (!onRichSelectionChange || !canEdit) return;
      if (document.activeElement !== field) return;
      const sel = readCellSelection(field);
      const domSel = field.ownerDocument.getSelection();
      if (!sel || sel.end <= sel.start || !domSel?.rangeCount) {
        onRichSelectionChange(null);
        return;
      }
      const rect = domSel.getRangeAt(0).getBoundingClientRect();
      const emitRichSelection = callbacksRef.current.onRichSelectionChange;
      if (!emitRichSelection) return;
      if (!rect.width && !rect.height) {
        emitRichSelection(null);
        return;
      }
      emitRichSelection({
        row,
        column,
        start: sel.start,
        end: sel.end,
        rect,
        text,
      });
    };

    const forcePaint = () => {
      previousPaint.current = undefined;
      paintCell();
    };

    const abort = new AbortController();
    const opts = { signal: abort.signal };
    paintCell();
    doc.on("beforeAllTransactions", rememberSelection);
    text.observe(paintCell);
    field.addEventListener("beforeinput", onBeforeInput, opts);
    field.addEventListener("compositionstart", onCompositionStart, opts);
    field.addEventListener("compositionend", onCompositionEnd, opts);
    field.addEventListener("keydown", onKeyDown, opts);
    field.addEventListener("copy", (e) => onCopyOrCut(e, false), opts);
    field.addEventListener("cut", (e) => onCopyOrCut(e, true), opts);
    field.addEventListener("paste", onPaste, opts);
    field.addEventListener("page-refresh-text", forcePaint, opts);
    field.ownerDocument.addEventListener(
      "selectionchange",
      emitSelection,
      opts,
    );

    return () => {
      abort.abort();
      doc.off("beforeAllTransactions", rememberSelection);
      text.unobserve(paintCell);
    };
  }, [model, text, row, column, canEdit]);

  return (
    <>
      <div
        ref={ref}
        data-cell-editor=""
        data-cell-input=""
        data-row={row}
        data-column={column}
        data-cell-protected={textProtection}
        contentEditable={canEdit}
        suppressContentEditableWarning
        tabIndex={canEdit ? 0 : -1}
        onFocus={() => onFocusCell?.(row, column)}
      />
      {objects.map(({ el, object, key }) =>
        createPortal(
          <Suspense fallback={null}>
            <InlineObject
              field={ref.current!}
              object={object}
              line={line}
              readonly={!canEdit}
            />
          </Suspense>,
          el,
          key,
        ),
      )}
    </>
  );
}
