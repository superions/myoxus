import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { Signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/editor/global/lit";
import type { ColorScheme } from "@virgultum/editor/model";
import { ShadowlessElement } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import { html } from "lit";
import { property } from "lit/decorators.js";

import { createTextRenderer } from "../../components/text-renderer";

export class ChatContentRichText extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false })
  accessor text!: string;

  @property({ attribute: false })
  accessor state: "finished" | "generating" = "finished";

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor theme!: Signal<ColorScheme>;

  @property({ attribute: false })
  accessor annotation = false;

  protected override render() {
    const { text } = this;
    // Chat keeps the editor's complete global heading roles. Other action
    // renderers may still opt into the separate compact-heading presentation.
    return html`${createTextRenderer({
      extensions: this.extensions,
      myoxusFeatureFlagService: this.myoxusFeatureFlagService,
      theme: this.theme,
      annotation: this.annotation,
    })(text, this.state)}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-content-rich-text": ChatContentRichText;
  }
}
