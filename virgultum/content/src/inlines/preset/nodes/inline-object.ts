// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect, signal } from "@preact/signals-core";
import { NativeViewElement, type BlockStdScope } from "@virgultum/core/runtime";
import type { InlineEditor } from "@virgultum/core/runtime/inline";
import type { DeltaInsert } from "@virgultum/core/store";
import type { MyoxusTextAttributes } from "@virgultum/core/types";

type Binding = {
  std: BlockStdScope;
  editor: InlineEditor<MyoxusTextAttributes>;
  delta: DeltaInsert<MyoxusTextAttributes>;
  startOffset: number;
};

/** The native caret belongs to the editor. The adjacent portal keeps React state across edits. */
export abstract class InlineObject extends NativeViewElement {
  private readonly binding = signal<Binding>();
  private release?: () => void;
  set context(value: Binding) {
    this.binding.value = value;
  }
  protected get std() {
    return this.binding.value!.std;
  }
  protected get editor() {
    return this.binding.value!.editor;
  }
  protected get delta() {
    return this.binding.value!.delta;
  }
  protected get startOffset() {
    return this.binding.value!.startOffset;
  }
  protected abstract mountObject(
    anchor: HTMLElement,
    source: HTMLElement,
  ): (() => void) | undefined;
  connectedCallback() {
    const doc = this.ownerDocument,
      source = doc.createElement("span"),
      anchor = doc.createElement("span");
    source.hidden = true;
    source.setAttribute("aria-hidden", "true");
    const text = doc.createElement("v-text");
    source.append(text);
    this.replaceChildren(source, anchor);
    const stopText = effect(() => {
      text.str = this.delta.insert;
    });
    const unmount = this.mountObject(anchor, source);
    this.release = () => {
      stopText();
      unmount?.();
    };
  }
  disconnectedCallback() {
    this.release?.();
    this.release = undefined;
  }
}
