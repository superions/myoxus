// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { computed, effect, signal } from "@preact/signals-core";
import {
  EditorChromeHostIdentifier,
  type EditorBlockCaptionControls,
} from "@virgultum/core/services";
import {
  type BlockStdScope,
  NativeViewElement,
  installEditorStyles,
  TextSelection,
} from "@virgultum/core/runtime";
import { type BlockModel, Text } from "@virgultum/core/store";
import { captionStyles } from "./block-caption";

/** One block-scoped input session; only the native view owns focus and input chrome. */
export class BlockCaptionEditor extends NativeViewElement {
  private release?: () => void;
  private shown = signal(false);
  private focusRequest = signal(0);
  private valid = () =>
    this.isConnected &&
    !this.model.store.readonly &&
    this.model.store.getBlock(this.model.id)?.model === this.model;
  show = () => {
    if (!this.valid()) return;
    this.shown.value = true;
    this.focusRequest.value++;
  };
  private change = (caption: string) => {
    if (this.valid()) this.model.store.updateBlock(this.model, { caption });
  };
  private enter = (input: HTMLTextAreaElement) => {
    const store = this.model.store;
    const parent = store.getParent(this.model);
    const start = input.selectionStart;
    if (!this.valid() || !parent || parent.flavour === "myoxus:surface")
      return false;
    // Page Enter splits the caption into the following paragraph; canvas Enter
    // remains native multiline input. Release input focus before range binding.
    const tail = input.value.slice(start);
    this.change(input.value.slice(0, start));
    const blockId = store.addBlock(
      "myoxus:paragraph",
      { text: new Text(tail) },
      parent,
      parent.children.indexOf(this.model) + 1,
    );
    input.blur();
    this.std.selection.setGroup("note", [
      this.std.selection.create(TextSelection, {
        from: { blockId, index: 0, length: 0 },
        to: null,
      }),
    ]);
    return true;
  };
  connectedCallback() {
    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) {
      installEditorStyles(this, captionStyles);
      const caption = this.ownerDocument.createElement("figcaption");
      caption.className = "block-caption-static";
      this.release = effect(() => {
        const value = this.model.props.caption$.value;
        if (!value) {
          caption.remove();
          return;
        }
        caption.textContent = value;
        if (!caption.parentNode) this.append(caption);
      });
      return;
    }
    const controls = computed<EditorBlockCaptionControls>(() => ({
      getSnapshot: () => this.model.props.caption$.value ?? "",
      subscribe: (listener) => this.model.props.caption$.subscribe(listener),
      readonly: this.model.store.readonly,
      focusRequest: this.focusRequest.value,
      change: this.change,
      enter: this.enter,
      setFocused: (focused) => {
        this.shown.value = focused;
      },
    }));
    const visible = computed(
      () => this.shown.value || Boolean(this.model.props.caption$.value),
    );
    this.release = effect(() =>
      visible.value ? chrome.mountBlockCaption(this, controls) : undefined,
    );
  }
  disconnectedCallback() {
    this.release?.();
    this.release = undefined;
  }
  model!: BlockModel<{
    caption: string | null | undefined;
  }>;
  std!: BlockStdScope;
}

declare global {
  interface HTMLElementTagNameMap {
    "block-caption-editor": BlockCaptionEditor;
  }
}
