// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
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
import { plainPageLines, type PageLine } from "./plain-page-model";

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
  ) {
    const { signal } = this.stop;
    root.addEventListener("beforeinput", this.input, { signal });
    root.addEventListener("compositionstart", this.start, { signal });
    root.addEventListener("compositionend", this.end, { signal });
    root.addEventListener("paste", this.paste, { signal });
    root.addEventListener("keydown", this.key, { signal });
    root.addEventListener("cut", this.cut, { signal });
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
    const r = this.current && resolveBookmark(this.page, this.current);
    if (
      !r ||
      (r.anchor.id === r.focus.id && r.anchor.offset === r.focus.offset)
    )
      return [];
    return segments(this.lines(), r)
      .filter((p) => p.line.kind !== "title")
      .map((p) => p.line.model.id);
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
      !!plainPageLines(this.page)
    );
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
  afterRender() {
    if (this.retired || this.composing) return;
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
      !this.root.contains(e.target as Node) ||
      !(e.target as Element).closest("[data-page-text],[data-page-body]") ||
      e.isComposing ||
      !this.canWrite()
    )
      return;
    if (
      e.key === "Tab" ||
      ((e.ctrlKey || e.metaKey) &&
        ["k", "e", "Enter", "[", "]"].includes(
          e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ))
    ) {
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
          range.focus.id !== lines[0].model.id
        ) {
          if (this.write(range, e.data)) {
            this.current = bookmark(lines, this.after!) ?? undefined;
            this.after = undefined;
            if (this.current)
              this.handoff(this.current, {
                kind: "slash",
                trigger: e.data,
                start: this.current,
              });
          }
        } else {
          const line = lines.find((l) => l.model.id === range.focus.id);
          const prefix =
            line?.text.toString().slice(0, range.focus.offset) ?? "";
          // Let the established shortcut/reference owners consume their actual
          // triggering input once, rather than inserting a second marker.
          if (
            (line?.kind !== "title" &&
              (e.data === "@" ||
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
