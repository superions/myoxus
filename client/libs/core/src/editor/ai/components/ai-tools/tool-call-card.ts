import { ToolIcon } from "@myoxus/icons/lit";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { ToolCallCardView } from "./tool-call-card-view";

export class ToolCallCard extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false }) accessor name = "Tool calling";
  @property({ attribute: false }) accessor icon: TemplateResult<1> = ToolIcon();

  protected override render() {
    // Static editor previews have no React host. Keep their inert summary;
    // interactive chat/Peek uses the original host's providers and portal.
    return this.reactToLit
      ? this.reactToLit(
          createElement(ToolCallCardView, {
            name: this.name,
            icon: toReactNode(this.icon),
          }),
          true,
        )
      : html`${this.name}`;
  }
}
