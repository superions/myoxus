// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { NativeViewElement } from "@virgultum/core/runtime";
import {
  ZERO_WIDTH_FOR_EMPTY_LINE,
  inlineChild,
  setInlineStyles,
} from "@virgultum/core/runtime/inline";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import type { DeltaInsert } from "@virgultum/core/store";

type Run = { content: string; color?: string };

export abstract class HighlightedText extends NativeViewElement {
  private source: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  };
  get delta() {
    return this.source;
  }
  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    this.source = value;
    if (this.isConnected) this.paint();
  }
  connectedCallback() {
    this.paint();
  }
  protected abstract paint(): void;

  /** Stale asynchronous tokenization must never replace the current editable source. */
  protected paintRuns(
    tokens: readonly Run[],
    styles: Parameters<typeof setInlineStyles>[1] = {},
  ) {
    const runs =
      tokens.length &&
      tokens.map((t) => t.content).join("") === this.delta.insert
        ? tokens
        : [{ content: this.delta.insert }];
    const span = inlineChild(this, "span");
    setInlineStyles(span, styles);
    runs.forEach((part, index) => {
      const text =
        (span.children.item(index) as HTMLElementTagNameMap["v-text"] | null) ??
        this.ownerDocument.createElement("v-text");
      text.str = part.content;
      text.style.color = String(styles.color ?? part.color ?? "");
      if (!text.parentNode) span.append(text);
    });
    while (span.children.length > runs.length) span.lastElementChild!.remove();
  }
}
