// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { NativeViewElement } from "../../../primitives/env/index.js";
import { ZERO_WIDTH_FOR_EMPTY_LINE } from "../consts.js";

/** A text run keeps one DOM Text node so selection endpoints survive model updates. */
export class VText extends NativeViewElement {
  private value: string = ZERO_WIDTH_FOR_EMPTY_LINE;
  private text?: Text;

  get str() {
    return this.value;
  }

  set str(value: string) {
    if (this.value === value) return;
    this.value = value;
    if (this.text && this.text.data !== value) this.text.data = value;
  }

  connectedCallback() {
    if (this.text) return;
    const span = this.ownerDocument.createElement("span");
    span.dataset.vText = "true";
    span.style.wordBreak = "break-word";
    span.style.textWrap = "wrap";
    span.style.whiteSpaceCollapse = "break-spaces";
    this.text = this.ownerDocument.createTextNode(this.value);
    span.append(this.text);
    this.append(span);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "v-text": VText;
  }
}
