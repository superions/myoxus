import {
  ErrorCode,
  VirgultumError,
} from "../../../primitives/exceptions/index";
import { NativeViewElement } from "../../../primitives/env/index.js";
import type { DeltaInsert } from "../../../store/index";

import { INLINE_ROOT_ATTR } from "../consts.js";
import type { InlineRootElement } from "../inline-editor.js";
import { isMaybeInlineRangeEqual } from "../utils/inline-range.js";
import { createEmbedGap } from "./embed-gap.js";

export class VLine extends NativeViewElement {
  get inlineEditor() {
    const rootElement = this.closest(
      `[${INLINE_ROOT_ATTR}]`,
    ) as InlineRootElement;
    if (!rootElement) {
      throw new VirgultumError(
        VirgultumError.ErrorCode.ValueNotExists,
        "v-line must be inside a v-root",
      );
    }
    const inlineEditor = rootElement.inlineEditor;
    if (!inlineEditor) {
      throw new VirgultumError(
        VirgultumError.ErrorCode.ValueNotExists,
        "v-line must be inside a v-root with inline-editor",
      );
    }

    return inlineEditor;
  }

  get vElements() {
    return Array.from(this.querySelectorAll("v-element"));
  }

  get vTextContent() {
    return this.vElements.reduce((acc, el) => acc + el.delta.insert, "");
  }

  get vTextLength() {
    return this.vElements.reduce((acc, el) => acc + el.delta.insert.length, 0);
  }

  // you should use vElements.length or vTextLength because v-element corresponds to the actual delta
  get vTexts() {
    return Array.from(this.querySelectorAll("v-text"));
  }

  startOffset = 0;
  endOffset = 0;
  index = 0;

  constructor() {
    super();
    this.addEventListener("mousedown", (e) => {
      if (e.detail >= 2 && this.startOffset === this.endOffset) {
        e.preventDefault();
        return;
      }

      if (e.detail >= 3) {
        e.preventDefault();
        const editor = this.inlineEditor;
        const range = {
          index: this.startOffset,
          length: this.endOffset - this.startOffset,
        };
        const previous = editor.getInlineRange();
        // The first click can collapse the DOM selection before selectionchange
        // updates the model. Reapply an equal range on a repeated triple click.
        if (isMaybeInlineRangeEqual(previous, range))
          editor.syncInlineRange(range);
        else editor.setInlineRange(range);
      }
    });
  }

  get updateComplete() {
    return Promise.all(this.vElements.map((element) => element.updateComplete));
  }

  connectedCallback() {
    this.style.display = "block";
  }

  /** Retain the run at each text position so a model update cannot detach a
   * native selection or an active IME composition from unchanged text. */
  updateLine(
    chunk: readonly DeltaInsert[],
    index: number,
    startOffset: number,
  ) {
    const editor = this.inlineEditor;
    const doc = this.ownerDocument;
    this.index = index;
    this.startOffset = startOffset;
    let offset = startOffset;
    if (editor.lineNumbers) {
      let number = this.firstElementChild as HTMLElement | null;
      if (!number || number.className !== "line-number") {
        number = doc.createElement("span");
        number.className = "line-number";
        number.contentEditable = "false";
        this.prepend(number);
      }
      const label = String(index + 1);
      if (number.textContent !== label) number.textContent = label;
    }
    let body = this.lastElementChild;
    if (!(body instanceof HTMLDivElement)) {
      body = doc.createElement("div");
      this.append(body);
    }
    const contents = body as HTMLDivElement;
    contents.style.padding = chunk.length ? "0 0.5px" : "";
    contents.style.display = chunk.length ? "inline-block" : "";

    let next = contents.firstChild;
    function use<T extends HTMLElement>(tag: string, create: () => T) {
      const keep = next instanceof HTMLElement && next.localName === tag;
      const element = keep ? (next as T) : create();
      if (!keep) contents.insertBefore(element, next);
      next = element.nextSibling;
      return element;
    }
    const gap = () => use("span", () => createEmbedGap(doc));
    if (!chunk.length) use("v-text", () => doc.createElement("v-text"));
    const embeds = chunk.map((delta) => editor.isEmbed(delta));
    chunk.forEach((delta, i) => {
      const embed = embeds[i];
      if (embed === true && delta.insert.length !== 1)
        throw new VirgultumError(
          ErrorCode.InlineEditorError,
          "Embedded elements must occupy a single character.",
        );
      if (typeof embed === "string" || (embed && i === 0)) gap();
      const element = use("v-element", () => doc.createElement("v-element"));
      element.updateRun({
        editor,
        delta: {
          insert: delta.insert,
          attributes: editor.attributeService.normalizeAttributes(
            delta.attributes,
          ),
        },
        startOffset: offset,
        endOffset: offset + delta.insert.length,
        lineIndex: index,
      });
      offset += delta.insert.length;
      if (
        typeof embed === "string" ||
        (embed && (i === chunk.length - 1 || embeds[i + 1]))
      )
        gap();
    });
    while (next) {
      const rest = next.nextSibling;
      next.remove();
      next = rest;
    }
    this.endOffset = offset;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "v-line": VLine;
  }
}
