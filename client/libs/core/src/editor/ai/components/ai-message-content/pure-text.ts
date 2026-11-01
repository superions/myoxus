// SPDX-License-Identifier: MIT
import type { ReactToLit } from "@myoxus/lit-react";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";
import { ChatPlainText } from "../message-chrome";

export class ChatContentPureText extends ShadowlessElement {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor text = "";
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "chat-content-pure-text";
  private readonly stopCopy = (event: Event) => event.stopPropagation();
  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("copy", this.stopCopy);
  }
  override disconnectedCallback() {
    this.removeEventListener("copy", this.stopCopy);
    super.disconnectedCallback();
  }
  protected override render() {
    if (!this.reactToLit || !this.text) return nothing;
    return this.reactToLit(
      createElement(ChatPlainText, { text: this.text }),
      true,
    );
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "chat-content-pure-text": ChatContentPureText;
  }
}
