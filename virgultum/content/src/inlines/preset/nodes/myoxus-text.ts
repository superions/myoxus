import { myoxusTextStyles } from "@virgultum/core/styles";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import {
  inlineChild,
  setInlineStyles,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/core/runtime/inline";
import type { DeltaInsert } from "@virgultum/core/store";

export class MyoxusText extends NativeViewElement {
  private value: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  };
  get delta() {
    return this.value;
  }
  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    this.value = value;
    if (this.isConnected) this.updateText();
  }
  connectedCallback() {
    this.updateText();
  }
  private updateText() {
    const { attributes, insert } = this.value;
    const run = inlineChild(this, attributes?.code ? "code" : "span");
    setInlineStyles(run, attributes ? myoxusTextStyles(attributes) : {});
    inlineChild(run, "v-text", { str: insert });
  }
}
