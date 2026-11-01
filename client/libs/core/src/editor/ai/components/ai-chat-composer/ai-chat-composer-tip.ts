// SPDX-License-Identifier: MIT
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createElement } from "react";
import { ChatDisclaimer } from "../message-chrome";

/** Disclaimers remain readable in full, not an animated clipped message ticker. */
@customElement("ai-chat-composer-tip")
export class AIChatComposerTip extends ShadowlessElement {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor tips: TemplateResult[] = [];
  protected override render() {
    return this.reactToLit
      ? this.reactToLit(
          createElement(
            ChatDisclaimer,
            null,
            ...this.tips.map((tip) => toReactNode(tip)),
          ),
          true,
        )
      : nothing;
  }
}
