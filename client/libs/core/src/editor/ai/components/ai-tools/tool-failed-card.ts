import { ToolIcon } from "@myoxus/icons/lit";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { ToolFailedCardView } from "./tool-failed-card-view";

export class ToolFailedCard extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false }) accessor name = "Tool calling failed";
  @property({ attribute: false }) accessor icon: TemplateResult<1> = ToolIcon();

  protected override render() {
    return this.reactToLit
      ? this.reactToLit(
          createElement(ToolFailedCardView, {
            name: this.name,
            icon: toReactNode(this.icon),
          }),
          true,
        )
      : html`${this.name}`;
  }
}
