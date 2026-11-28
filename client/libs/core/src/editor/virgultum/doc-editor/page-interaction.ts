// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrameworkProvider } from "@myoxus/infra";
import { captureLeafTextSelection } from "@virgultum/core/adapters/copy";
import { TextSelection } from "@virgultum/core/runtime";
import {
  Text,
  type BlockModel,
  type DeltaInsert,
  type Store,
} from "@virgultum/core/store";
import type { DocumentField } from "@virgultum/core/types";
import {
  appendPageParagraph,
  getLastNoteBlock,
  isValidUrl,
  normalizeUrl,
} from "@virgultum/core/utils";
import {
  bookmark,
  deletionRange,
  inputTarget,
  readPageRange,
  replacePageRange,
  resolveBookmark,
  restorePageRange,
  segments,
  type PageBookmark,
  type PageRange,
} from "./plain-page-input";
import { readPageContent, type PageLine } from "./plain-page-model";
import { duplicatePageBlock, pasteAfterPageBlock } from "./page-block-actions";
import { sliceYTextDelta } from "./page-table-cell";

export type PickerStart = { start: PageBookmark; trigger: string };

export type PageBlockConversionTarget =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "quote"
  | "bulleted"
  | "numbered"
  | "todo"
  | "code"
  | "callout";

export type PageInteractionCallbacks = {
  openInlineLink?: () => void;
  openTemplateVariable?: (anchor: {
    blockId: string;
    from: number;
    to: number;
  }) => void;
};

/** The DOM owns an IME preedit; the Store owns its final replacement. Remote
 * edits move the bookmarked endpoints without replacing the composing node. */
export class PageInteraction {
  private readonly stop = new AbortController();
  private composing?: {
    selection: PageBookmark;
    field: HTMLElement;
  };
  private current?: PageBookmark;
  private after?: PageRange;
  private marks?: Record<string, unknown>;
  private retired = false;
  private selecting = false;
  constructor(
    private readonly page: Store,
    private readonly root: HTMLElement,
    private readonly lines: () => PageLine[],
    private readonly writable: () => boolean,
    private readonly refresh: () => void,
    private readonly picker: (start: PickerStart) => void,
    private readonly framework: FrameworkProvider,
    private readonly slash?: (start: PickerStart) => void,
    private readonly callbacks?: PageInteractionCallbacks,
  ) {
    const { signal } = this.stop;
    root.addEventListener("beforeinput", this.input, { signal });
    root.addEventListener("compositionstart", this.start, { signal });
    root.addEventListener("compositionend", this.end, { signal });
    root.addEventListener("paste", this.paste, { signal });
    root.addEventListener("keydown", this.key, { signal });
    root.addEventListener("cut", this.cut, { signal });
    root.addEventListener("copy", this.copyBlock, { signal });
    root.addEventListener("focusin", this.focusBlock, { signal });
    root.addEventListener(
      "pointerdown",
      (e) => {
        this.selecting =
          e.button === 0 &&
          e.target instanceof Element &&
          !!e.target.closest("[data-page-text]");
      },
      { signal },
    );
    const finishSelection = () => {
      if (this.selecting) {
        this.selecting = false;
        this.remember();
      }
    };
    document.addEventListener("pointerup", finishSelection, { signal });
    document.addEventListener("pointercancel", finishSelection, { signal });
    document.addEventListener("selectionchange", this.remember, { signal });
    page.spaceDoc.on("beforeAllTransactions", this.remember);
  }
  get isComposing() {
    return !!this.composing;
  }
  get selection() {
    return this.after
      ? (bookmark(this.lines(), this.after) ?? this.current)
      : this.current;
  }
  selectedBlocks() {
    const selected = this.selectedDivider();
    if (selected) return [selected.id];
    const r = this.current && resolveBookmark(this.page, this.current);
    if (
      !r ||
      (r.anchor.id === r.focus.id && r.anchor.offset === r.focus.offset)
    )
      return [];
    const body = readPageContent(this.page)?.order;
    if (!body) return [];
    const a = body.findIndex((b) => b.model.id === r.anchor.id);
    const b = body.findIndex((b) => b.model.id === r.focus.id);
    if (a < 0 || b < 0) return [];
    return body
      .slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1)
      .map((b) => b.model.id);
  }
  selectedText(): string {
    const r = this.current && resolveBookmark(this.page, this.current);
    if (!r) return "";
    return segments(this.lines(), r)
      .map(({ line, from, to }) => line.text.toString().slice(from, to))
      .join("\n");
  }
  selectedTextSelection(): TextSelection | null {
    const r = this.current && resolveBookmark(this.page, this.current);
    if (!r) return null;
    const parts = segments(this.lines(), r).filter(
      (part) => part.line.kind !== "title",
    );
    if (!parts.length) return null;
    const first = parts[0];
    const last = parts.at(-1)!;
    if (first === last) {
      if (first.to <= first.from) return null;
      return new TextSelection({
        from: {
          blockId: first.line.model.id,
          index: first.from,
          length: first.to - first.from,
        },
        to: null,
      });
    }
    return new TextSelection({
      from: {
        blockId: first.line.model.id,
        index: first.from,
        length: first.line.text.length - first.from,
      },
      to: {
        blockId: last.line.model.id,
        index: 0,
        length: last.to,
      },
    });
  }
  applyLink(rawUrl: string, replacementText?: string) {
    if (!this.canWrite() || !this.current) return false;
    const url = normalizeUrl(rawUrl.trim());
    if (!url || !isValidUrl(url)) return false;
    const range = resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range).filter(
      (part) =>
        part.line.kind !== "title" && !this.page.hasFixedText(part.line.model),
    );
    if (!parts.length) return false;
    let nextRange: PageRange = range;
    this.page.captureSync();
    this.page.transact(() => {
      if (parts.length === 1) {
        const { line, from, to } = parts[0];
        const label = replacementText?.trim();
        if (to === from) {
          const text = label || url;
          line.text.insert(from, text, { link: url });
          nextRange = {
            anchor: { id: line.model.id, offset: from },
            focus: { id: line.model.id, offset: from + text.length },
          };
        } else if (label && label !== line.text.toString().slice(from, to)) {
          line.text.delete(from, to - from);
          line.text.insert(from, label, { link: url });
          nextRange = {
            anchor: { id: line.model.id, offset: from },
            focus: { id: line.model.id, offset: from + label.length },
          };
        } else {
          line.text.format(from, to - from, { link: url });
        }
      } else {
        for (const { line, from, to } of parts) {
          if (to > from) line.text.format(from, to - from, { link: url });
        }
      }
    });
    this.page.captureSync();
    this.after = nextRange;
    this.refresh();
    return true;
  }
  insertTemplateToken(
    token: string,
    explicit?: { blockId: string; from: number; to: number },
  ) {
    if (!this.canWrite()) return false;
    const range = explicit
      ? {
          anchor: { id: explicit.blockId, offset: explicit.from },
          focus: { id: explicit.blockId, offset: explicit.to },
        }
      : this.current && resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range).filter(
      (p) => !this.page.hasFixedText(p.line.model),
    );
    const first = parts[0];
    if (!first) return false;
    const deleteLen = first.to - first.from;
    this.page.captureSync();
    this.page.transact(() => {
      if (deleteLen > 0) first.line.text.delete(first.from, deleteLen);
      first.line.text.insert(first.from, token);
    });
    this.page.captureSync();
    const point = {
      id: first.line.model.id,
      offset: first.from + token.length,
    };
    const nextRange = { anchor: point, focus: point };
    this.after = nextRange;
    this.current = bookmark(this.lines(), nextRange) ?? undefined;
    this.refresh();
    return true;
  }
  insertDocumentField(
    field: DocumentField,
    explicit?: { blockId: string; from: number; to: number },
  ) {
    if (!this.canWrite()) return false;
    const range = explicit
      ? {
          anchor: { id: explicit.blockId, offset: explicit.from },
          focus: { id: explicit.blockId, offset: explicit.to },
        }
      : this.current && resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range).filter(
      (p) => p.line.kind !== "title" && !this.page.hasFixedText(p.line.model),
    );
    const first = parts[0];
    if (!first) return false;
    const deleteLen = first.to - first.from;
    this.page.captureSync();
    this.page.transact(() => {
      if (deleteLen > 0) first.line.text.delete(first.from, deleteLen);
      first.line.text.insert(first.from, " ", { documentField: field });
    });
    this.page.captureSync();
    const point = { id: first.line.model.id, offset: first.from + 1 };
    this.after = { anchor: point, focus: point };
    this.refresh();
    return true;
  }
  replaceSelectionWithLinkedDoc(docId: string) {
    if (!this.canWrite() || !this.current) return false;
    const range = resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range).filter(
      (p) => p.line.kind !== "title" && !this.page.hasFixedText(p.line.model),
    );
    const first = parts[0];
    if (!first) return false;
    this.page.captureSync();
    this.page.transact(() => {
      const last = parts.at(-1)!;
      if (parts.length === 1) {
        first.line.text.delete(first.from, first.to - first.from);
      } else {
        first.line.text.delete(first.from, first.line.text.length - first.from);
        for (const middle of parts.slice(1, -1)) {
          if (middle.line.model.children.length === 0)
            this.page.deleteBlock(middle.line.model);
        }
        last.line.text.delete(0, last.to);
      }
      first.line.text.insert(first.from, " ", {
        reference: { type: "LinkedPage", pageId: docId },
      });
    });
    this.page.captureSync();
    const point = { id: first.line.model.id, offset: first.from + 1 };
    this.after = { anchor: point, focus: point };
    this.refresh();
    return true;
  }
  convertSelectedBlocks(target: PageBlockConversionTarget) {
    if (!this.canWrite() || !this.current) return false;
    const range = resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range).filter(
      (p) =>
        p.line.kind !== "title" &&
        !this.page.hasFixedText(p.line.model) &&
        (p.line.model.flavour === "myoxus:paragraph" ||
          p.line.model.flavour === "myoxus:list"),
    );
    if (!parts.length) return false;
    let focusId = parts[0].line.model.id;
    let focusOffset = parts[0].from;
    this.page.captureSync();
    this.page.transact(() => {
      for (const { line } of parts) {
        const model = line.model;
        const parent = model.parent;
        if (!parent) continue;
        const idx = parent.children.indexOf(model);
        if (idx < 0) continue;
        const isParagraphTarget =
          target === "text" || target === "quote" || /^h[1-6]$/.test(target);
        const isListTarget =
          target === "bulleted" || target === "numbered" || target === "todo";

        if (isParagraphTarget && model.flavour === "myoxus:paragraph") {
          this.page.updateBlock(model, { type: target });
          continue;
        }
        if (isListTarget && model.flavour === "myoxus:list") {
          this.page.updateBlock(model, {
            type: target,
            ...(target === "todo" ? { checked: false } : {}),
          });
          continue;
        }
        if (target === "code") {
          const id = this.page.addBlock(
            "myoxus:code",
            {
              text: new Text(line.text.toString()),
              language: "Plain Text",
            },
            parent,
            idx,
          );
          if (model.children.length === 0) this.page.deleteBlock(model);
          else line.text.delete(0, line.text.length);
          if (model.id === focusId) {
            focusId = id;
            focusOffset = 0;
          }
          continue;
        }
        if (target === "callout") {
          const calloutId = this.page.addBlock(
            "myoxus:callout",
            { type: "note" },
            parent,
            idx,
          );
          const childId = this.page.addBlock(
            "myoxus:paragraph",
            { text: new Text(line.text.toDelta() as DeltaInsert[]) },
            calloutId,
            0,
          );
          if (model.children.length) {
            this.page.moveBlocks(
              model.children,
              this.page.getModelById(calloutId)!,
              undefined,
              false,
            );
          }
          this.page.deleteBlock(model);
          if (model.id === focusId) {
            focusId = childId;
          }
          continue;
        }
        // Switch between paragraph and list while preserving text & children.
        const newFlavour = isListTarget ? "myoxus:list" : "myoxus:paragraph";
        const newProps: Record<string, unknown> = {
          type: target,
          text: new Text(line.text.toDelta() as DeltaInsert[]),
        };
        if (target === "todo") newProps.checked = false;
        const createdId = this.page.addBlock(newFlavour, newProps, parent, idx);
        const createdModel = this.page.getModelById(createdId);
        if (createdModel && model.children.length) {
          this.page.moveBlocks(model.children, createdModel, undefined, false);
        }
        this.page.deleteBlock(model);
        if (model.id === focusId) {
          focusId = createdId;
        }
      }
    });
    this.page.captureSync();
    if (this.page.getModelById(focusId)?.text) {
      const point = {
        id: focusId,
        offset: Math.min(
          focusOffset,
          this.page.getModelById(focusId)?.text?.length ?? 0,
        ),
      };
      this.after = { anchor: point, focus: point };
    }
    this.refresh();
    return true;
  }
  duplicateSelectedBlocks() {
    if (!this.canWrite()) return false;
    const ids = this.selectedBlocks();
    const models = ids
      .map((id) => this.page.getModelById(id))
      .filter((m): m is BlockModel => !!m && m.flavour !== "myoxus:page");
    if (!models.length) return false;
    let lastId: string | null = null;
    for (const model of models) {
      lastId = duplicatePageBlock(model) ?? lastId;
    }
    if (lastId && this.page.getModelById(lastId)?.text) {
      this.focusPoint(lastId, 0);
    }
    return Boolean(lastId);
  }
  deleteSelectedBlocks() {
    if (!this.canWrite()) return false;
    const range = this.current && resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range).filter(
      (p) => p.line.kind !== "title" && !this.page.hasFixedText(p.line.model),
    );
    if (!parts.length) return false;
    this.page.captureSync();
    this.page.transact(() => {
      for (const { line } of parts) {
        if (this.page.getModelById(line.model.id) === line.model)
          this.page.deleteBlock(line.model);
      }
    });
    this.page.captureSync();
    this.refresh();
    return true;
  }
  copySelectedBlocks() {
    const ids = this.selectedBlocks();
    const models = ids
      .map((id) => this.page.getModelById(id))
      .filter((m): m is BlockModel => !!m && m.flavour !== "myoxus:page");
    if (!models.length) return;
    const { signal } = this.stop;
    void import("./page-block-copy")
      .then(({ copyPageBlocks }) =>
        copyPageBlocks(models, this.framework, signal),
      )
      .catch((error) => {
        if (!signal.aborted) console.error(error);
      });
  }
  private selectedDivider() {
    const el = this.root.ownerDocument.activeElement;
    const id =
      el instanceof HTMLElement &&
      this.root.contains(el) &&
      el.dataset.pageDivider;
    const model = id ? this.page.getModelById(id) : null;
    return model?.flavour === "myoxus:divider" ? model : null;
  }
  private focusBlock = () => {
    const target = this.root.ownerDocument.activeElement;
    if (
      !(target instanceof Element) ||
      !target.closest("[data-block-id][contenteditable=false]")
    )
      return;
    this.current = undefined;
    this.after = undefined;
    if (this.selectedDivider())
      this.root.ownerDocument.getSelection()?.removeAllRanges();
  };
  /** A card's visible DOM can contain a resolved server record. Copy/cut rich
   * inline objects or multi-block ranges directly through the Store serializer. */
  private handleMixedClipboard(e: ClipboardEvent, action: "copy" | "cut") {
    const range = readPageRange(this.root);
    if (
      !range ||
      (range.anchor.id === range.focus.id &&
        range.anchor.offset === range.focus.offset)
    )
      return false;
    const parts = segments(this.lines(), range);
    const inline = parts.some(({ line, from, to }) => {
      let pos = 0;
      return line.text
        .toDelta()
        .some(
          (op: { insert: string; attributes?: Record<string, unknown> }) => {
            const start = pos;
            pos += op.insert.length;
            return (
              start < to &&
              pos > from &&
              (op.attributes?.annotation ||
                op.attributes?.reference ||
                op.attributes?.footnote ||
                op.attributes?.mention ||
                op.attributes?.documentField ||
                typeof op.attributes?.latex === "string")
            );
          },
        );
    });
    if (!inline && range.anchor.id === range.focus.id) return false;
    const part = parts.length === 1 ? parts[0] : undefined;
    const { signal } = this.stop;
    if (part) {
      const { model } = part.line;
      const selection = captureLeafTextSelection(
        model,
        part.from,
        part.to - part.from,
      );
      if (selection) {
        e.preventDefault();
        if (e.clipboardData) {
          e.clipboardData.setData(
            "text/plain",
            part.line.text.toString().slice(part.from, part.to),
          );
        }
        void import("./page-block-copy")
          .then(({ copyPageBlock }) =>
            copyPageBlock(model, this.framework, signal, selection),
          )
          .catch((error) => {
            if (!signal.aborted) console.error(error);
          });
        if (
          action === "cut" &&
          this.canWrite() &&
          !this.page.hasFixedText(model)
        ) {
          this.write(range, "");
        }
        return true;
      }
    }
    const body = readPageContent(this.page)?.order;
    if (!body) return false;
    const a = body.findIndex((b) => b.model.id === range.anchor.id);
    const b = body.findIndex((b) => b.model.id === range.focus.id);
    if (a < 0 || b < 0) return false;
    const sliceItems = body.slice(Math.min(a, b), Math.max(a, b) + 1);
    const hasAtomic = sliceItems.some((block) => !("text" in block));
    if (!inline && !hasAtomic) return false;
    e.preventDefault();
    const models = sliceItems.map((item) => item.model);
    if (e.clipboardData) {
      e.clipboardData.setData(
        "text/plain",
        document.getSelection()?.toString() ?? "",
      );
    }
    void import("./page-block-copy")
      .then(({ copyPageBlocks }) =>
        copyPageBlocks(models, this.framework, signal),
      )
      .catch((error) => {
        if (!signal.aborted) console.error(error);
      });
    if (action === "cut" && this.canWrite()) {
      if (
        !parts.some((p) => this.page.hasFixedText(p.line.model)) &&
        !this.write(range, "")
      ) {
        this.page.captureSync();
        this.page.transact(() => {
          for (const item of sliceItems) {
            if (this.page.getModelById(item.model.id) === item.model)
              this.page.deleteBlock(item.model);
          }
        });
        this.page.captureSync();
        this.refresh();
      }
    }
    return true;
  }
  private copyBlock = (event: ClipboardEvent) => {
    if (
      (event.target as Element)?.closest?.(
        "[contenteditable=false][data-block-id]",
      )
    )
      return;
    if (this.handleMixedClipboard(event, "copy")) return;
    if (!this.selectedDivider() || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", "---");
    event.clipboardData.setData("text/html", "<hr>");
  };
  private leaveDivider(direction: number, remove: boolean, insert = false) {
    const block = this.selectedDivider(),
      parent = block?.parent;
    if (!block || !parent) return;
    if ((remove || insert) && !this.canWrite()) return;
    const siblings = parent.children,
      index = siblings.indexOf(block);
    let next: (typeof siblings)[number] | undefined =
      siblings[index + direction] ?? siblings[index - direction];
    let id = next?.id;
    if (remove || insert) {
      this.page.captureSync();
      this.page.transact(() => {
        if (remove) this.page.deleteBlock(block);
        if (insert || !next) {
          id = this.page.addBlock(
            "myoxus:paragraph",
            {},
            parent,
            index + (insert ? 1 : 0),
          );
          next = undefined;
        }
      });
      this.page.captureSync();
    }
    if (!id) return;
    if (next?.flavour === "myoxus:divider") {
      this.root
        .querySelector<HTMLElement>(`[data-page-divider="${CSS.escape(id)}"]`)
        ?.focus();
    } else if (next && !next.text) {
      this.root
        .querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`)
        ?.focus();
    } else {
      const point = {
        id,
        offset:
          next && next === siblings[index - 1] ? (next.text?.length ?? 0) : 0,
      };
      this.root.querySelector<HTMLElement>("[data-page-body]")?.focus();
      this.after = { anchor: point, focus: point };
      this.refresh();
    }
  }
  restore() {
    if (this.current) {
      const r = resolveBookmark(this.page, this.current);
      if (r) {
        const target = this.root.querySelector<HTMLElement>(
          `[data-page-text="${CSS.escape(r.focus.id)}"]`,
        );
        const focusHost =
          target?.closest<HTMLElement>("[contenteditable='true']") ?? target;
        focusHost?.focus({ preventScroll: true });
        restorePageRange(this.root, r);
      }
    }
  }
  private canWrite() {
    return (
      !this.retired &&
      this.writable() &&
      !this.page.readonly &&
      !!readPageContent(this.page)
    );
  }
  pickerRange(start: PickerStart) {
    if (!this.canWrite() || this.composing) return;
    const from = resolveBookmark(this.page, start.start)?.focus;
    const range = this.after ?? readPageRange(this.root);
    if (
      !from ||
      !range ||
      range.focus.id !== from.id ||
      range.anchor.id !== from.id ||
      range.anchor.offset !== range.focus.offset
    )
      return;
    const line = this.lines().find((l) => l.model.id === from.id);
    const raw = line?.text.toString().slice(from.offset, range.focus.offset);
    if (!line || !raw?.startsWith(start.trigger)) return;
    return {
      line,
      from,
      end: range.focus,
      query: raw.slice(start.trigger.length),
    };
  }
  consumePicker(start: PickerStart, query: string) {
    const range = this.pickerRange(start);
    if (
      !range ||
      range.query !== query ||
      this.page.hasFixedText(range.line.model)
    )
      return;
    const { line, from, end } = range;
    let slot = bookmark(this.lines(), { anchor: from, focus: from });
    this.page.captureSync();
    this.page.transact(() =>
      line.text.delete(from.offset, end.offset - from.offset),
    );
    this.after = { anchor: from, focus: from };
    this.refresh();
    return (id: string, kind: "reference" | "mention" = "reference") => {
      const at = slot && resolveBookmark(this.page, slot)?.focus;
      if (!at || !this.canWrite() || this.page.hasFixedText(line.model)) return;
      this.page.transact(() =>
        line.text.insert(
          at.offset,
          " ",
          kind === "mention"
            ? { mention: { member: id } }
            : {
                reference: { type: "LinkedPage", pageId: id },
              },
        ),
      );
      this.page.captureSync();
      const next = { id: at.id, offset: at.offset + 1 };
      this.after = { anchor: next, focus: next };
      slot = bookmark(this.lines(), this.after);
      this.refresh();
      return {
        model: line.model,
        text: line.text,
        index: at.offset,
        mode: "page" as const,
      };
    };
  }
  consumeSlash(
    start: PickerStart,
    query: string,
    run?: (ctx: {
      line: PageLine;
      offset: number;
    }) => { id: string; offset: number } | void,
  ): { line: PageLine; offset: number } | undefined {
    const range = this.pickerRange(start);
    if (
      !range ||
      range.query !== query ||
      this.page.hasFixedText(range.line.model)
    )
      return;
    const { line, from, end } = range;
    let nextPoint: { id: string; offset: number } | undefined;
    this.page.captureSync();
    this.page.transact(() => {
      line.text.delete(from.offset, end.offset - from.offset);
      nextPoint = run?.({ line, offset: from.offset }) ?? undefined;
    });
    this.page.captureSync();
    const target = nextPoint ?? from;
    if (this.page.getModelById(target.id)?.text) {
      this.root
        .querySelector<HTMLElement>("[data-page-body]")
        ?.focus({ preventScroll: true });
      this.after = { anchor: target, focus: target };
    }
    this.refresh();
    return { line, offset: from.offset };
  }
  focusPoint(id: string, offset = 0) {
    if (this.retired) return;
    const model = this.page.getModelById(id);
    const clamped = Math.max(0, Math.min(model?.text?.length ?? 0, offset));
    const point = { id, offset: clamped };
    this.root
      .querySelector<HTMLElement>("[data-page-body]")
      ?.focus({ preventScroll: true });
    this.after = { anchor: point, focus: point };
    this.refresh();
  }
  openLinkPicker(blockId: string, offset: number) {
    if (!this.canWrite()) return;
    const line = this.lines().find((l) => l.model.id === blockId);
    if (!line || this.page.hasFixedText(line.model)) return;
    const clamped = Math.max(0, Math.min(line.text.length, offset));
    const at = { id: blockId, offset: clamped };
    const start = bookmark(this.lines(), { anchor: at, focus: at });
    if (!start) return;
    this.page.captureSync();
    this.page.transact(() => line.text.insert(clamped, "[["));
    this.page.captureSync();
    const after = { id: blockId, offset: clamped + 2 };
    this.root
      .querySelector<HTMLElement>("[data-page-body]")
      ?.focus({ preventScroll: true });
    this.after = { anchor: after, focus: after };
    this.refresh();
    this.picker({ start, trigger: "[[" });
  }
  private remember = () => {
    if (this.composing || this.after || this.retired) return;
    const range = readPageRange(this.root);
    if (range) {
      const old = this.current && resolveBookmark(this.page, this.current);
      if (
        !old ||
        old.focus.id !== range.focus.id ||
        old.focus.offset !== range.focus.offset
      )
        this.marks = undefined;
      this.current = bookmark(this.lines(), range) ?? undefined;
    }
  };
  focusPageEnd() {
    if (!this.canWrite() || this.composing) return;
    const last = getLastNoteBlock(this.page)?.lastChild();
    const id =
      last?.flavour === "myoxus:paragraph" && last.text?.length === 0
        ? last.id
        : appendPageParagraph(this.page);
    if (!id) return;
    const point = { id, offset: 0 };
    this.root
      .querySelector<HTMLElement>("[data-page-body]")
      ?.focus({ preventScroll: true });
    this.after = { anchor: point, focus: point };
    this.refresh();
  }
  afterRender() {
    // The browser owns a pointer drag until release. Restoring the last
    // collapsed caret during a preview update would move the drag's anchor.
    if (this.retired || this.composing || this.selecting) return;
    const next =
      this.after ??
      (this.current && this.root.contains(document.activeElement)
        ? resolveBookmark(this.page, this.current)
        : null);
    this.after = undefined;
    if (next) {
      restorePageRange(this.root, next);
      this.current = bookmark(this.lines(), next) ?? undefined;
    }
  }
  dispose() {
    this.retired = true;
    this.stop.abort();
    this.page.spaceDoc.off("beforeAllTransactions", this.remember);
  }
  private write(range: PageRange, value: string) {
    const next = replacePageRange(
      this.page,
      this.lines(),
      range,
      value,
      this.marks,
    );
    if (next) {
      this.after = next;
      this.refresh();
    }
    return !!next;
  }
  private indentRange(range: PageRange, outdent: boolean): boolean {
    if (!this.canWrite()) return false;
    const parts = segments(this.lines(), range).filter(
      (p) =>
        p.line.kind !== "title" &&
        !this.page.hasFixedText(p.line.model) &&
        (p.line.model.flavour === "myoxus:paragraph" ||
          p.line.model.flavour === "myoxus:list"),
    );
    if (!parts.length) return false;
    let changed = false;
    this.page.captureSync();
    this.page.transact(() => {
      if (outdent) {
        for (const { line } of [...parts].reverse()) {
          const model = line.model;
          const parent = model.parent;
          const grandParent = parent?.parent;
          if (
            !parent ||
            !grandParent ||
            parent.flavour === "myoxus:note" ||
            parent.flavour === "myoxus:page" ||
            parent.flavour === "myoxus:callout"
          )
            continue;
          try {
            const schemas = this.page.schema.flavourSchemaMap;
            this.page.schema.validateSchema(
              schemas.get(model.flavour)!,
              schemas.get(grandParent.flavour)!,
            );
          } catch {
            continue;
          }
          const idx = parent.children.indexOf(model);
          const trailingSiblings = parent.children.slice(idx + 1);
          this.page.moveBlocks([model], grandParent, parent, false);
          if (trailingSiblings.length) {
            this.page.moveBlocks(trailingSiblings, model, undefined, false);
          }
          changed = true;
        }
      } else {
        for (const { line } of parts) {
          const model = line.model;
          const parent = model.parent;
          if (!parent) continue;
          const idx = parent.children.indexOf(model);
          if (idx <= 0) continue;
          const prev = parent.children[idx - 1];
          if (
            prev.flavour !== "myoxus:paragraph" &&
            prev.flavour !== "myoxus:list"
          )
            continue;
          try {
            const schemas = this.page.schema.flavourSchemaMap;
            this.page.schema.validateSchema(
              schemas.get(model.flavour)!,
              schemas.get(prev.flavour)!,
            );
          } catch {
            continue;
          }
          this.page.moveBlocks([model], prev, undefined, false);
          changed = true;
        }
      }
    });
    this.page.captureSync();
    if (changed) {
      this.after = range;
      this.refresh();
    }
    return changed;
  }
  private applyMarkdownPrefix(line: PageLine, prefix: string): boolean {
    const model = line.model;
    const parent = model.parent;
    if (!parent || this.page.hasFixedText(model)) return false;

    const headingMatch = /^(#{1,6})$/.exec(prefix);
    if (headingMatch && model.flavour === "myoxus:paragraph") {
      const level = `h${headingMatch[1].length}` as
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      this.page.captureSync();
      this.page.transact(() => {
        line.text.delete(0, prefix.length);
        this.page.updateBlock(model, { type: level });
      });
      this.page.captureSync();
      const point = { id: model.id, offset: 0 };
      this.after = { anchor: point, focus: point };
      this.refresh();
      return true;
    }

    const bulletMatch = /^[-*+]$/.test(prefix);
    const numberMatch = /^([0-9]+)[.)]$/.exec(prefix);
    const todoMatch = /^\[( |x|X)?\]$/.exec(prefix);
    if (bulletMatch || numberMatch || todoMatch) {
      const listType = bulletMatch
        ? "bulleted"
        : numberMatch
          ? "numbered"
          : "todo";
      const listProps: Record<string, unknown> = { type: listType };
      if (numberMatch) listProps.order = Number(numberMatch[1]);
      if (todoMatch) listProps.checked = /x/i.test(todoMatch[1] ?? "");

      let targetId = model.id;
      this.page.captureSync();
      this.page.transact(() => {
        line.text.delete(0, prefix.length);
        if (model.flavour === "myoxus:list") {
          this.page.updateBlock(model, listProps);
        } else {
          const idx = parent.children.indexOf(model);
          listProps.text = new Text(line.text.toDelta() as DeltaInsert[]);
          targetId = this.page.addBlock("myoxus:list", listProps, parent, idx);
          const created = this.page.getModelById(targetId);
          if (created && model.children.length) {
            this.page.moveBlocks(model.children, created, undefined, false);
          }
          this.page.deleteBlock(model);
        }
      });
      this.page.captureSync();
      const point = { id: targetId, offset: 0 };
      this.after = { anchor: point, focus: point };
      this.refresh();
      return true;
    }

    const codeMatch = /^```(.*)$/.exec(prefix);
    if (codeMatch && this.page.schema.flavourSchemaMap.has("myoxus:code")) {
      const language = codeMatch[1].trim() || "Plain Text";
      let codeId = "";
      this.page.captureSync();
      this.page.transact(() => {
        line.text.delete(0, prefix.length);
        const remaining = line.text.toString();
        const idx = parent.children.indexOf(model);
        codeId = this.page.addBlock(
          "myoxus:code",
          { language, text: new Text(remaining) },
          parent,
          idx,
        );
        if (model.children.length === 0) {
          this.page.deleteBlock(model);
        }
      });
      this.page.captureSync();
      this.refresh();
      if (codeId) {
        requestAnimationFrame(() => {
          this.root
            .querySelector<HTMLElement>(
              `[data-block-id="${CSS.escape(codeId)}"] textarea, [data-block-id="${CSS.escape(codeId)}"]`,
            )
            ?.focus({ preventScroll: true });
        });
      }
      return true;
    }

    return false;
  }
  private quoteBreak(range: PageRange, soft: boolean) {
    if (range.anchor.id !== range.focus.id) return false;
    const line = this.lines().find((l) => l.model.id === range.focus.id);
    if (
      line?.kind !== "quote" ||
      !this.canWrite() ||
      this.page.hasFixedText(line.model)
    )
      return false;
    const parent = line.model.parent;
    if (!parent) return false;
    const from = Math.min(range.anchor.offset, range.focus.offset),
      to = Math.max(range.anchor.offset, range.focus.offset);
    let point = { id: line.model.id, offset: from + 1 };
    this.page.captureSync();
    this.page.transact(() => {
      if (
        !soft &&
        from === to &&
        from === line.text.length &&
        line.text.toString().endsWith("\n")
      ) {
        line.text.delete(from - 1, 1);
        const hasChildren = !!line.model.children.length;
        point = {
          id: this.page.addBlock(
            "myoxus:paragraph",
            {},
            hasChildren ? line.model : parent,
            hasChildren ? 0 : parent.children.indexOf(line.model) + 1,
          ),
          offset: 0,
        };
      } else {
        if (to > from) line.text.delete(from, to - from);
        line.text.insert(from, "\n");
      }
    });
    this.page.captureSync();
    this.after = { anchor: point, focus: point };
    this.refresh();
    return true;
  }
  private softLineBreak(range: PageRange): boolean {
    if (range.anchor.id !== range.focus.id) return false;
    const line = this.lines().find((l) => l.model.id === range.focus.id);
    if (
      !line ||
      line.kind === "title" ||
      !this.canWrite() ||
      this.page.hasFixedText(line.model)
    )
      return false;
    const from = Math.min(range.anchor.offset, range.focus.offset);
    const to = Math.max(range.anchor.offset, range.focus.offset);
    this.page.captureSync();
    this.page.transact(() => {
      if (to > from) line.text.delete(from, to - from);
      line.text.insert(from, "\n");
    });
    this.page.captureSync();
    const point = { id: line.model.id, offset: from + 1 };
    this.after = { anchor: point, focus: point };
    this.refresh();
    return true;
  }
  private exitEmptyListOrHeading(line: PageLine): boolean {
    if (!this.canWrite() || this.page.hasFixedText(line.model)) return false;
    if (line.model.flavour === "myoxus:list") {
      if (line.depth > 0) {
        const point = { id: line.model.id, offset: 0 };
        return this.indentRange({ anchor: point, focus: point }, true);
      }
      const parent = line.model.parent;
      if (!parent) return false;
      const idx = parent.children.indexOf(line.model);
      let nextId = "";
      this.page.captureSync();
      this.page.transact(() => {
        nextId = this.page.addBlock(
          "myoxus:paragraph",
          {
            type: "text",
            text: new Text(line.text.toDelta() as DeltaInsert[]),
          },
          parent,
          idx,
        );
        const created = this.page.getModelById(nextId);
        if (created && line.model.children.length) {
          this.page.moveBlocks(line.model.children, created, undefined, false);
        }
        this.page.deleteBlock(line.model);
      });
      this.page.captureSync();
      const point = { id: nextId, offset: 0 };
      this.after = { anchor: point, focus: point };
      this.refresh();
      return true;
    }
    if (line.heading || line.kind === "quote") {
      this.page.captureSync();
      this.page.updateBlock(line.model, { type: "text" });
      this.page.captureSync();
      const point = { id: line.model.id, offset: 0 };
      this.after = { anchor: point, focus: point };
      this.refresh();
      return true;
    }
    return false;
  }
  markActive(key: string) {
    const range = this.current && resolveBookmark(this.page, this.current);
    if (!range) return false;
    const parts = segments(this.lines(), range);
    if (!parts.length) return false;
    const collapsed = parts.length === 1 && parts[0].from === parts[0].to;
    return collapsed && this.marks && key in this.marks
      ? Boolean(this.marks[key])
      : parts.every(({ line, from, to }) => {
          let pos = 0;
          if (!line.text.length) return false;
          if (collapsed) {
            from = Math.max(0, from - 1);
            to = from + 1;
          }
          return line.text
            .toDelta()
            .every(
              (op: {
                insert: string;
                attributes?: Record<string, unknown>;
              }) => {
                const start = pos;
                pos += op.insert.length;
                return pos <= from || start >= to || !!op.attributes?.[key];
              },
            );
        });
  }
  /** Read just the selected runs; mixed tones must not select a menu option. */
  labelTone(): string | null {
    const range = this.current && resolveBookmark(this.page, this.current);
    if (!range) return null;
    const values = new Set<string | null>();
    for (const { line, from, to } of segments(this.lines(), range)) {
      let pos = 0;
      for (const run of line.text.toDelta()) {
        const start = pos;
        pos += run.insert.length;
        if (pos > from && start < to)
          values.add(run.attributes?.labelTone ?? null);
      }
    }
    return values.size > 1 ? "mixed" : (values.values().next().value ?? null);
  }
  private selectedBodyLines() {
    const range = this.current && resolveBookmark(this.page, this.current);
    return range
      ? segments(this.lines(), range)
          .map((p) => p.line)
          .filter(
            (l) =>
              l.model.flavour === "myoxus:paragraph" ||
              l.model.flavour === "myoxus:list",
          )
      : [];
  }
  alignment() {
    const counts = new Map<string, number>();
    for (const line of this.selectedBodyLines()) {
      const value = line.alignment ?? "left";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  private eyebrowLines() {
    const range = this.current && resolveBookmark(this.page, this.current);
    if (!range) return [];
    const parts = segments(this.lines(), range);
    if (
      !parts.length ||
      parts.some(
        (p) =>
          p.line.kind !== "text" ||
          !!p.line.heading ||
          p.line.model.flavour !== "myoxus:paragraph",
      )
    )
      return [];
    const body = readPageContent(this.page)?.order;
    if (!body) return [];
    const first = body.findIndex((b) => b.model === parts[0].line.model);
    const last = body.findIndex((b) => b.model === parts.at(-1)!.line.model);
    return last - first + 1 === parts.length ? parts : [];
  }
  eyebrowState() {
    const parts = this.eyebrowLines();
    return parts.length ? parts.every((p) => p.line.eyebrow) : undefined;
  }
  toggleEyebrow() {
    if (!this.canWrite()) return;
    const parts = this.eyebrowLines();
    if (!parts.length) return;
    const remove = parts.every((p) => p.line.eyebrow);
    this.page.captureSync();
    this.page.transact(() => {
      for (const {
        line: { model },
      } of parts) {
        if (remove)
          this.page.updateBlock(model, () => {
            Reflect.deleteProperty(model.props, "presentation");
          });
        else this.page.updateBlock(model, { presentation: "eyebrow" });
      }
    });
    this.page.captureSync();
    this.restore();
  }
  align(value: string) {
    if (!this.canWrite() || !["left", "center", "right"].includes(value))
      return;
    const lines = this.selectedBodyLines();
    if (!lines.some((line) => (line.alignment ?? "left") !== value)) return;
    this.page.captureSync();
    this.page.transact(() => {
      for (const { model } of lines)
        this.page.updateBlock(model, { textAlign: value });
    });
    this.page.captureSync();
    this.restore();
  }
  format(key: string, value?: string | null) {
    if (!this.canWrite() || !this.current) return;
    const range = resolveBookmark(this.page, this.current);
    if (!range) return;
    const parts = segments(this.lines(), range).filter(
      (part) => !this.page.hasFixedText(part.line.model),
    );
    if (!parts.length) return;
    const attrs = {
      [key]: value === undefined ? (this.markActive(key) ? null : true) : value,
    };
    if (parts.every((p) => p.from === p.to)) {
      this.marks = { ...this.marks, ...attrs };
      return;
    }
    this.page.captureSync();
    this.page.transact(() => {
      for (const { line, from, to } of parts)
        if (to > from) line.text.format(from, to - from, attrs);
    });
    this.page.captureSync();
    this.after = range;
    this.refresh();
  }
  private key = (e: KeyboardEvent) => {
    if (
      (e.target as Element)?.closest?.(
        "[contenteditable=false][data-block-id]:not([data-page-divider])",
      )
    )
      return;
    if (
      this.selectedDivider() &&
      !e.isComposing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      if (
        [
          "ArrowDown",
          "ArrowRight",
          "ArrowUp",
          "ArrowLeft",
          "Backspace",
          "Delete",
          "Enter",
        ].includes(e.key)
      ) {
        e.preventDefault();
        this.leaveDivider(
          ["ArrowUp", "ArrowLeft", "Backspace"].includes(e.key) ? -1 : 1,
          e.key === "Delete" || e.key === "Backspace",
          e.key === "Enter",
        );
      }
      return;
    }
    if (
      !this.root.contains(e.target as Node) ||
      (e.target as Element)?.closest?.(
        "[contenteditable=false][data-block-id]",
      ) ||
      !(e.target as Element).closest("[data-page-text],[data-page-body]") ||
      e.isComposing ||
      !this.canWrite()
    )
      return;
    const range = readPageRange(this.root);
    if (
      range &&
      range.anchor.id === range.focus.id &&
      range.anchor.offset === range.focus.offset &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const line = this.lines().find((l) => l.model.id === range.focus.id);
      if (
        line &&
        e.key === "Backspace" &&
        range.focus.offset === 0 &&
        (line.kind === "quote" ||
          Boolean(line.heading) ||
          line.model.flavour === "myoxus:list")
      ) {
        e.preventDefault();
        this.exitEmptyListOrHeading(line);
        return;
      }
      const backwards = e.key === "Backspace" || e.key === "ArrowUp";
      const forwards = e.key === "Delete" || e.key === "ArrowDown";
      if (
        line &&
        ((backwards && range.focus.offset === 0) ||
          (forwards && range.focus.offset === line.text.length))
      ) {
        const siblings = line.model.parent?.children;
        const adjacent =
          siblings?.[siblings.indexOf(line.model) + (backwards ? -1 : 1)];
        if (
          adjacent &&
          !["myoxus:paragraph", "myoxus:list"].includes(adjacent.flavour)
        ) {
          const selector =
            adjacent.flavour === "myoxus:divider"
              ? `[data-page-divider="${CSS.escape(adjacent.id)}"]`
              : `[data-block-id="${CSS.escape(adjacent.id)}"]`;
          const el = this.root.querySelector<HTMLElement>(selector);
          if (el) {
            e.preventDefault();
            el.focus();
            return;
          }
        }
      }
    }
    if (
      e.key === "ArrowDown" &&
      BUILD_CONFIG.isElectron &&
      (e.target as Element).closest("[data-page-title]")
    ) {
      const first = this.lines()[1];
      if (first) {
        e.preventDefault();
        this.root.querySelector<HTMLElement>("[data-page-body]")?.focus();
        const start = { id: first.model.id, offset: 0 };
        restorePageRange(this.root, { anchor: start, focus: start });
        this.remember();
      }
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (range) {
        e.preventDefault();
        this.indentRange(range, e.shiftKey);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === "z" || key === "y") {
        e.preventDefault();
        key === "y" || e.shiftKey ? this.page.redo() : this.page.undo();
      } else if (["b", "i", "u", "e"].includes(key)) {
        e.preventDefault();
        this.remember();
        this.format(
          (
            {
              b: "bold",
              i: "italic",
              u: "underline",
              e: "code",
            } as Record<string, string>
          )[key],
        );
      } else if (key === "[" || key === "]") {
        if (range) {
          e.preventDefault();
          this.indentRange(range, key === "[");
        }
      } else if (key === "k") {
        e.preventDefault();
        this.remember();
        this.callbacks?.openInlineLink?.();
      } else if (key === "Enter" && range) {
        if (this.quoteBreak(range, true)) {
          e.preventDefault();
          return;
        }
        const line = this.lines().find((l) => l.model.id === range.focus.id);
        if (line?.kind === "todo") {
          e.preventDefault();
          this.page.captureSync();
          this.page.updateBlock(line.model, { checked: !line.checked });
          this.page.captureSync();
          this.after = range;
          this.refresh();
        }
      }
    }
  };
  private input = (e: InputEvent) => {
    if (
      (e.target as Element)?.closest?.("[contenteditable=false][data-block-id]")
    )
      return;
    if (
      !(e.target instanceof Element) ||
      !e.target.closest("[data-page-text],[data-page-body]")
    )
      return;
    if (
      this.composing &&
      (e.isComposing || e.inputType === "insertCompositionText")
    )
      return;
    const range =
      (e.inputType.startsWith("delete") ||
      e.inputType === "insertReplacementText"
        ? inputTarget(this.root, e)
        : null) ?? readPageRange(this.root);
    e.preventDefault();
    if (!range || !this.canWrite()) return;
    const lines = this.lines();
    if (
      segments(lines, range).some((part) =>
        this.page.hasFixedText(part.line.model),
      )
    )
      return;
    switch (e.inputType) {
      case "insertText":
      case "insertReplacementText": {
        if (!e.data) return;
        if (
          (e.data === "/" || e.data === "、") &&
          range.focus.id !== this.page.root?.id
        ) {
          if (this.write(range, e.data) && this.after && this.slash) {
            const at = {
              id: this.after.focus.id,
              offset: Math.max(0, this.after.focus.offset - e.data.length),
            };
            const start = bookmark(this.lines(), { anchor: at, focus: at });
            if (start) {
              this.slash({ start, trigger: e.data });
            }
          }
          break;
        }
        const line = lines.find((l) => l.model.id === range.focus.id);
        const prefix = line?.text.toString().slice(0, range.focus.offset) ?? "";
        const collapsed =
          range.anchor.id === range.focus.id &&
          range.anchor.offset === range.focus.offset;
        const trigger =
          e.data === "@"
            ? "@"
            : e.data === "[" && prefix.endsWith("[")
              ? "[["
              : e.data === "【" && prefix.endsWith("【")
                ? "【【"
                : undefined;
        if (
          trigger &&
          line &&
          line.kind !== "title" &&
          collapsed &&
          !prefix.includes("%%")
        ) {
          const at = {
            id: line.model.id,
            offset: range.focus.offset - (trigger.length - 1),
          };
          const start = bookmark(lines, { anchor: at, focus: at });
          if (start && this.write(range, e.data)) {
            this.picker({ start, trigger });
            break;
          }
        }
        if (
          line &&
          line.kind !== "title" &&
          collapsed &&
          e.data === "%" &&
          prefix.endsWith("%") &&
          this.callbacks?.openTemplateVariable
        ) {
          const from = range.focus.offset - 1;
          this.page.captureSync();
          this.page.transact(() => line.text.delete(from, 1));
          this.page.captureSync();
          const point = { id: line.model.id, offset: from };
          this.after = { anchor: point, focus: point };
          this.refresh();
          this.callbacks.openTemplateVariable({
            blockId: line.model.id,
            from,
            to: from,
          });
          break;
        }
        if (
          line?.kind === "text" &&
          !line.eyebrow &&
          e.data === " " &&
          prefix === ">" &&
          collapsed
        ) {
          this.page.captureSync();
          this.page.transact(() => {
            line.text.delete(0, 1);
            this.page.updateBlock(line.model, { type: "quote" });
          });
          this.page.captureSync();
          const point = { id: line.model.id, offset: 0 };
          this.after = { anchor: point, focus: point };
          this.refresh();
          break;
        }
        if (
          line?.kind === "text" &&
          e.data === " " &&
          /^(-{3,}|\*{3,}|_{3,})$/.test(prefix) &&
          collapsed &&
          line.model.parent
        ) {
          const parent = line.model.parent;
          this.page.captureSync();
          this.page.transact(() => {
            this.page.addBlock(
              "myoxus:divider",
              {},
              parent,
              parent.children.indexOf(line.model),
            );
            line.text.delete(0, prefix.length);
          });
          this.page.captureSync();
          const point = { id: line.model.id, offset: 0 };
          this.after = { anchor: point, focus: point };
          this.refresh();
          break;
        }
        if (
          line?.kind === "text" &&
          !line.eyebrow &&
          !line.heading &&
          e.data === " " &&
          collapsed &&
          /^(?:#{1,6}|[-*+]|[0-9]+[.)]|\[[ xX]?\]|```.*)$/.test(prefix) &&
          this.applyMarkdownPrefix(line, prefix)
        ) {
          break;
        }
        this.write(range, e.data);
        break;
      }
      case "insertParagraph":
      case "insertLineBreak": {
        if (this.quoteBreak(range, e.inputType === "insertLineBreak")) break;
        if (e.inputType === "insertLineBreak") {
          this.softLineBreak(range);
          break;
        }
        const line = lines.find((l) => l.model.id === range.focus.id);
        if (
          line &&
          line.kind !== "title" &&
          line.kind !== "text" &&
          !line.text.length &&
          range.anchor.id === range.focus.id &&
          range.anchor.offset === range.focus.offset
        ) {
          this.exitEmptyListOrHeading(line);
          break;
        }
        this.page.captureSync();
        if (!this.write(range, "\n") && line && line.kind !== "title") {
          // If splitting a block with children or a callout line, insert a
          // sibling/child paragraph directly on Store instead of dropping Enter.
          const parent = line.model.parent;
          if (parent) {
            const from = Math.min(range.anchor.offset, range.focus.offset);
            const to = Math.max(range.anchor.offset, range.focus.offset);
            let nextId = "";
            this.page.transact(() => {
              const tailDelta = sliceYTextDelta(
                line.text,
                to,
                line.text.length - to,
              );
              line.text.delete(from, line.text.length - from);
              const targetParent =
                line.model.flavour === "myoxus:callout" ||
                line.model.children.length
                  ? line.model
                  : parent;
              const targetIndex =
                targetParent === line.model
                  ? 0
                  : parent.children.indexOf(line.model) + 1;
              nextId = this.page.addBlock(
                "myoxus:paragraph",
                { text: new Text(tailDelta as DeltaInsert[]) },
                targetParent,
                targetIndex,
              );
            });
            const point = { id: nextId, offset: 0 };
            this.after = { anchor: point, focus: point };
            this.refresh();
          }
        }
        this.page.captureSync();
        break;
      }
      case "deleteContentBackward":
      case "deleteContentForward":
        this.write(
          deletionRange(lines, range, e.inputType === "deleteContentBackward"),
          "",
        );
        break;
      case "deleteWordBackward":
      case "deleteWordForward":
      case "deleteSoftLineBackward":
      case "deleteSoftLineForward":
      case "deleteHardLineBackward":
      case "deleteHardLineForward":
        this.write(range, "");
        break;
      case "historyUndo":
        this.page.undo();
        break;
      case "historyRedo":
        this.page.redo();
        break;
      case "formatBold":
      case "formatItalic":
      case "formatUnderline":
        this.remember();
        this.format(e.inputType.slice(6).toLowerCase());
        break;
    }
  };
  private cut = (e: ClipboardEvent) => {
    if (
      (e.target as Element)?.closest?.("[contenteditable=false][data-block-id]")
    )
      return;
    if (this.handleMixedClipboard(e, "cut")) return;
    if (this.selectedDivider()) {
      this.copyBlock(e);
      if (e.defaultPrevented) this.leaveDivider(1, true);
      return;
    }
    const range = readPageRange(this.root);
    if (!range || !e.clipboardData || !this.canWrite()) return;
    if (
      segments(this.lines(), range).some((part) =>
        this.page.hasFixedText(part.line.model),
      )
    ) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const r = document.getSelection()!.getRangeAt(0);
    const container = document.createElement("div");
    container.append(r.cloneContents());
    e.clipboardData.setData("text/plain", document.getSelection()!.toString());
    e.clipboardData.setData("text/html", container.innerHTML);
    this.write(range, "");
  };
  private paste = (e: ClipboardEvent) => {
    if (
      (e.target as Element)?.closest?.("[contenteditable=false][data-block-id]")
    )
      return;
    const block = this.selectedDivider();
    if (block && e.clipboardData) {
      e.preventDefault();
      if (!this.canWrite()) return;
      void pasteAfterPageBlock(block, e.clipboardData).catch(console.error);
      return;
    }
    const data = e.clipboardData,
      range = readPageRange(this.root);
    if (!data || !range) return;
    e.preventDefault();
    const lines = this.lines();
    const parts = segments(lines, range);
    if (
      !this.canWrite() ||
      parts.some((part) => this.page.hasFixedText(part.line.model))
    )
      return;
    const focusLine = lines.find((l) => l.model.id === range.focus.id);
    if (data.files.length && focusLine && focusLine.kind !== "title") {
      void pasteAfterPageBlock(focusLine.model, data).catch(console.error);
      return;
    }
    const html = data.getData("text/html");
    const plain = data.getData("text/plain");
    const hasVirgultumSnapshot =
      html.includes("data-virgultum-snapshot=") ||
      data.types.includes("VIRGULTUM/SNAPSHOT");
    const hasRichHtml = html.trim().length > 0;
    const hasStructuredMarkdown =
      plain.trim().length > 0 &&
      /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\$\$|---+\s*$)|\$\$[\s\S]+\$\$|\$[^$\n]+\$|%%[\s\S]+?%%|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\^[A-Za-z0-9_-]+(?:\s|$)|\n\s*\n/.test(
        plain,
      );
    if (
      (hasVirgultumSnapshot || hasRichHtml || hasStructuredMarkdown) &&
      focusLine &&
      focusLine.kind !== "title"
    ) {
      const targetParent = focusLine.model.parent;
      if (targetParent) {
        const types = Array.from(data.types);
        const values = new Map(types.map((type) => [type, data.getData(type)]));
        const replaceEmptyParagraph =
          focusLine.kind === "text" &&
          focusLine.text.length === 0 &&
          focusLine.model.children.length === 0;
        const insertIndex = targetParent.children.indexOf(focusLine.model) + 1;
        const placeholder = replaceEmptyParagraph ? focusLine.model : null;
        const signal = this.stop.signal;
        void import("./page-block-copy")
          .then(({ pastePageClipboard }) =>
            pastePageClipboard(
              { types, values },
              this.page,
              this.framework,
              targetParent.id,
              insertIndex,
              signal,
            ),
          )
          .then((inserted) => {
            if (signal.aborted) return;
            if (
              inserted &&
              placeholder &&
              this.page.getModelById(placeholder.id) === placeholder &&
              placeholder.text?.length === 0 &&
              placeholder.children.length === 0
            ) {
              this.page.deleteBlock(placeholder);
            }
            this.refresh();
          })
          .catch((error) => {
            if (!signal.aborted) console.error(error);
          });
        return;
      }
    }
    if (!plain) return;
    const trimmed = plain.trim();
    const nonCollapsed =
      range.anchor.id !== range.focus.id ||
      range.anchor.offset !== range.focus.offset;
    if (
      nonCollapsed &&
      trimmed &&
      !trimmed.includes("\n") &&
      isValidUrl(trimmed) &&
      focusLine?.kind !== "title"
    ) {
      this.current = bookmark(lines, range) ?? undefined;
      if (this.applyLink(trimmed)) return;
    }
    if (!this.write(range, plain) && focusLine) {
      // Fallback for blocks with children where multi-line split is restricted.
      const singleLine = plain.replace(/\r?\n/g, " ");
      const from = Math.min(range.anchor.offset, range.focus.offset);
      const to =
        range.anchor.id === range.focus.id
          ? Math.max(range.anchor.offset, range.focus.offset)
          : from;
      this.page.captureSync();
      this.page.transact(() => {
        if (to > from) focusLine.text.delete(from, to - from);
        focusLine.text.insert(from, singleLine, this.marks);
      });
      this.page.captureSync();
      const point = {
        id: focusLine.model.id,
        offset: from + singleLine.length,
      };
      this.after = { anchor: point, focus: point };
      this.refresh();
    }
  };
  private start = (e: CompositionEvent) => {
    if (
      (e.target as Element)?.closest?.("[contenteditable=false][data-block-id]")
    )
      return;
    const s = readPageRange(this.root);
    if (!s || !this.canWrite()) return;
    const field = this.root.querySelector<HTMLElement>(
        `[data-page-text="${CSS.escape(s.focus.id)}"]`,
      ),
      selection = bookmark(this.lines(), s);
    if (field && selection) this.composing = { field, selection };
  };
  private end = (e: CompositionEvent) => {
    const c = this.composing;
    if (!c) return;
    this.composing = undefined;
    const s = resolveBookmark(this.page, c.selection);
    if (s && e.data && !this.retired && this.writable() && !this.page.readonly)
      this.write(s, e.data);
    // React does not own the browser's temporary composition nodes.
    c.field.dispatchEvent(new Event("page-refresh-text"));
    this.refresh();
  };
}
