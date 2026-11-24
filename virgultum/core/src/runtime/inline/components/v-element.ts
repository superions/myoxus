import { computed, effect, signal } from "@preact/signals-core";
import { NativeViewElement } from "../../../primitives/env/index.js";
import {
  ErrorCode,
  VirgultumError,
} from "../../../primitives/exceptions/index";
import type { AttributeRenderer } from "../types.js";
import { inlineChild } from "../utils/attribute-renderer.js";
import { isInlineRangeIntersect } from "../utils/inline-range.js";

type Run = Omit<Parameters<AttributeRenderer>[0], "selected">;

export class VElement extends NativeViewElement {
  private readonly run = signal<Run | undefined>();
  private readonly selected = computed(() => {
    const run = this.run.value,
      range = run?.editor.inlineRange$.value;
    return (
      !!run &&
      !!range &&
      isInlineRangeIntersect(range, {
        index: run.startOffset,
        length: run.endOffset - run.startOffset,
      })
    );
  });
  private release?: () => void;
  private rendered?: HTMLElement;
  get inlineEditor() {
    return this.run.value!.editor;
  }
  get delta() {
    return this.run.value!.delta;
  }
  get lineIndex() {
    return this.run.value!.lineIndex;
  }
  get startOffset() {
    return this.run.value!.startOffset;
  }
  get endOffset() {
    return this.run.value!.endOffset;
  }
  updateRun(run: Run) {
    this.run.value = run;
  }
  get updateComplete() {
    const child = this.rendered;
    return Promise.resolve(
      child && "updateComplete" in child ? child.updateComplete : undefined,
    );
  }
  connectedCallback() {
    this.release = effect(() => {
      const run = this.run.value;
      if (!run) return;
      const wrapper = inlineChild(this, "span");
      wrapper.dataset.vElement = "true";
      const embed = run.editor.isEmbed(run.delta);
      if (embed === true && run.delta.insert.length !== 1) {
        throw new VirgultumError(
          ErrorCode.InlineEditorError,
          "An inline embed must occupy one character.",
        );
      }
      if (embed) {
        wrapper.dataset.vEmbed = "true";
        wrapper.contentEditable = "false";
        wrapper.style.userSelect = "none";
      } else if (wrapper.hasAttribute("data-v-embed")) {
        delete wrapper.dataset.vEmbed;
        wrapper.removeAttribute("contenteditable");
        wrapper.style.removeProperty("user-select");
      }
      this.rendered = run.editor.attributeService.attributeRenderer(
        { ...run, selected: this.selected.value },
        wrapper,
      );
    });
  }
  disconnectedCallback() {
    this.release?.();
    this.rendered = undefined;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "v-element": VElement;
  }
}
