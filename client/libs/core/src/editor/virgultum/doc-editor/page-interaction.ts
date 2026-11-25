// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrameworkProvider } from "@myoxus/infra";
import { captureLeafTextSelection } from "@virgultum/core/adapters/copy";
import type { Store } from "@virgultum/core/store";
import { appendPageParagraph, getLastNoteBlock } from "@virgultum/core/utils";
import {
  bookmark,
  deletionRange,
  readPageRange,
  inputTarget,
  replacePageRange,
  resolveBookmark,
  restorePageRange,
  segments,
  type PageBookmark,
  type PageIntent,
  type PageRange,
} from "./plain-page-input";
import { readPageContent, type PageLine } from "./plain-page-model";
import { pasteAfterPageBlock } from "./page-block-actions";
export type PickerStart = { start: PageBookmark; trigger: string };

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
    private readonly handoff: (
      range: PageBookmark | null,
      intent?: PageIntent,
    ) => void,
    private readonly picker: (start: PickerStart) => void,
    private readonly framework: FrameworkProvider,
    private readonly slash?: (start: PickerStart) => void,
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
    return body
      .slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1)
      .map((b) => b.model.id);
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
  /** A card's visible DOM can contain a resolved server record. Copy the
   * document reference through its model serializer, not the preview text. */
  private transferMixedClipboard(e: ClipboardEvent, action: "copy" | "cut") {
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
    if (action === "copy" && part) {
      const { model } = part.line;
      // Footnote copies can carry asset-bearing definition bodies through the source job.
      const runs = model.text?.sliceToDelta(part.from, part.to);
      if (
        runs?.some((run) => run.attributes?.reference) &&
        !runs.some((run) => run.attributes?.footnote)
      ) {
        const selection = captureLeafTextSelection(
          model,
          part.from,
          part.to - part.from,
        );
        if (selection) {
          e.preventDefault();
          const { signal } = this.stop;
          void import("./page-block-copy")
            .then(({ copyPageBlock }) =>
              copyPageBlock(model, this.framework, signal, selection),
            )
            .catch((error) => {
              if (!signal.aborted) console.error(error);
            });
          return true;
        }
      }
    }
    const body = readPageContent(this.page)?.order;
    if (!body) return false;
    const a = body.findIndex((b) => b.model.id === range.anchor.id);
    const b = body.findIndex((b) => b.model.id === range.focus.id);
    if (
      !inline &&
      !body
        .slice(Math.min(a, b) + 1, Math.max(a, b))
        .some((block) => !("text" in block))
    )
      return false;
    e.preventDefault();
    if (action === "copy" || this.canWrite())
      this.transfer({ kind: "range-clipboard", action });
    return true;
  }
  private copyBlock = (event: ClipboardEvent) => {
    if (this.transferMixedClipboard(event, "copy")) return;
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
  relinquish(intent?: PageIntent) {
    this.transfer(intent);
  }
  restore() {
    if (this.current) {
      const r = resolveBookmark(this.page, this.current);
      if (r) restorePageRange(this.root, r);
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
  private transfer(intent?: PageIntent) {
    this.remember();
    this.retired = true;
    this.handoff(this.current ?? null, intent);
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
    const parts = segments(this.lines(), range);
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
        line?.kind === "quote" &&
        e.key === "Backspace" &&
        range.focus.offset === 0
      ) {
        e.preventDefault();
        this.page.captureSync();
        this.page.updateBlock(line.model, { type: "text" });
        this.page.captureSync();
        this.after = range;
        this.refresh();
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
          !["myoxus:paragraph", "myoxus:list", "myoxus:divider"].includes(
            adjacent.flavour,
          )
        ) {
          // Navigation/deletion at a report boundary belongs to block
          // selection, never to the text line on the other side of the report.
          e.preventDefault();
          this.transfer({
            kind: "key",
            key: e.key,
            code: e.code,
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
          });
          return;
        }
        if (adjacent?.flavour === "myoxus:divider") {
          const el = this.root.querySelector<HTMLElement>(
            `[data-page-divider="${CSS.escape(adjacent.id)}"]`,
          );
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
    if (
      e.key === "Tab" ||
      ((e.ctrlKey || e.metaKey) &&
        ["k", "e", "Enter", "[", "]"].includes(
          e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ))
    ) {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        range &&
        this.quoteBreak(range, true)
      ) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      this.transfer({
        kind: "key",
        key: e.key,
        code: e.code,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === "z" || key === "y") {
        e.preventDefault();
        key === "y" || e.shiftKey ? this.page.redo() : this.page.undo();
      } else if (["b", "i", "u"].includes(key)) {
        e.preventDefault();
        this.remember();
        this.format(
          (
            { b: "bold", i: "italic", u: "underline" } as Record<string, string>
          )[key],
        );
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
    switch (e.inputType) {
      case "insertText":
      case "insertReplacementText": {
        if (!e.data) return;
        if (
          (e.data === "/" || e.data === "、") &&
          range.focus.id !== this.page.root?.id
        ) {
          if (this.write(range, e.data) && this.after) {
            if (this.slash) {
              const at = {
                id: this.after.focus.id,
                offset: Math.max(0, this.after.focus.offset - e.data.length),
              };
              const start = bookmark(this.lines(), { anchor: at, focus: at });
              if (start) {
                this.slash({ start, trigger: e.data });
                break;
              }
            } else {
              this.current = bookmark(lines, this.after) ?? undefined;
              this.after = undefined;
              if (this.current)
                this.handoff(this.current, {
                  kind: "slash",
                  trigger: e.data,
                  start: this.current,
                });
            }
          }
        } else {
          const line = lines.find((l) => l.model.id === range.focus.id);
          const prefix =
            line?.text.toString().slice(0, range.focus.offset) ?? "";
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
            range.anchor.id === range.focus.id &&
            range.anchor.offset === range.focus.offset &&
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
            line?.kind === "text" &&
            !line.eyebrow &&
            e.data === " " &&
            prefix === ">" &&
            range.anchor.id === range.focus.id &&
            range.anchor.offset === range.focus.offset &&
            !this.page.hasFixedText(line.model)
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
            range.anchor.id === range.focus.id &&
            range.anchor.offset === range.focus.offset &&
            !this.page.hasFixedText(line.model) &&
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
          // Let the established shortcut/reference owners consume their actual
          // triggering input once, rather than inserting a second marker.
          if (
            (line?.kind !== "title" &&
              (trigger ||
                (e.data === "%" && prefix.endsWith("%")) ||
                (e.data === "[" && prefix.endsWith("[")) ||
                (e.data === " " &&
                  /^(?:#{1,6}|[-*+>]|[0-9]+[.)]|\[[ x]?\]|```.*)$/.test(
                    prefix,
                  )))) ||
            !this.write(range, e.data)
          )
            this.transfer({
              kind: "input",
              inputType: e.inputType,
              data: e.data,
            });
        }
        break;
      }
      case "insertParagraph":
      case "insertLineBreak":
        {
          if (this.quoteBreak(range, e.inputType === "insertLineBreak")) break;
          this.page.captureSync();
          const line = lines.find((l) => l.model.id === range.focus.id);
          if (
            e.inputType === "insertLineBreak" ||
            (line &&
              line.kind !== "title" &&
              line.kind !== "text" &&
              !line.text.length) ||
            !this.write(range, "\n")
          )
            this.transfer({
              kind: "key",
              key: "Enter",
              code: "Enter",
              shiftKey: e.inputType === "insertLineBreak",
              altKey: false,
              ctrlKey: false,
              metaKey: false,
            });
          this.page.captureSync();
        }
        break;
      case "deleteContentBackward":
      case "deleteContentForward":
        if (
          !this.write(
            deletionRange(
              lines,
              range,
              e.inputType === "deleteContentBackward",
            ),
            "",
          )
        )
          this.transfer({ kind: "input", inputType: e.inputType, data: null });
        break;
      case "deleteWordBackward":
      case "deleteWordForward":
      case "deleteSoftLineBackward":
      case "deleteSoftLineForward":
      case "deleteHardLineBackward":
      case "deleteHardLineForward":
        if (!this.write(range, ""))
          this.transfer({ kind: "input", inputType: e.inputType, data: null });
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
    if (this.transferMixedClipboard(e, "cut")) return;
    if (this.selectedDivider()) {
      this.copyBlock(e);
      if (e.defaultPrevented) this.leaveDivider(1, true);
      return;
    }
    const range = readPageRange(this.root);
    if (!range || !e.clipboardData || !this.canWrite()) return;
    e.preventDefault();
    const r = document.getSelection()!.getRangeAt(0);
    const container = document.createElement("div");
    container.append(r.cloneContents());
    e.clipboardData.setData("text/plain", document.getSelection()!.toString());
    e.clipboardData.setData("text/html", container.innerHTML);
    if (!this.write(range, ""))
      this.transfer({ kind: "input", inputType: "deleteByCut", data: null });
  };
  private paste = (e: ClipboardEvent) => {
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
    if (!this.canWrite()) return;
    if (
      data.types.some((t) => t !== "text/plain") ||
      !this.write(range, data.getData("text/plain"))
    ) {
      const copy = new DataTransfer();
      for (const type of data.types) {
        if (type !== "Files") copy.setData(type, data.getData(type));
      }
      for (const f of data.files) copy.items.add(f);
      this.transfer({ kind: "paste", data: copy });
    }
  };
  private start = () => {
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
