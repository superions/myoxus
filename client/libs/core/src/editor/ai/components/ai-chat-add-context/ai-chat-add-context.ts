// SPDX-License-Identifier: MIT
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { ContextPicker } from "../ai-chat-chips/context-picker";
import type { ChatChip, DocDisplayConfig } from "../ai-chat-chips";
import type { SearchMenuConfig } from "./type";

export class AIChatAddContext extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor docId: string | undefined;
  @property({ attribute: false }) accessor independentMode: boolean | undefined;
  @property({ attribute: false }) accessor disabled = false;
  @property({ attribute: false }) accessor addChip!: (
    chip: ChatChip,
  ) => Promise<void>;
  @property({ attribute: false }) accessor addImages!: (images: File[]) => void;
  @property({ attribute: false }) accessor docDisplayConfig!: DocDisplayConfig;
  @property({ attribute: false }) accessor searchMenuConfig!: SearchMenuConfig;
  @property({ attribute: false }) accessor portalContainer: HTMLElement | null =
    null;

  override render() {
    if (!this.reactToLit) return nothing;
    return this.reactToLit(
      createElement(ContextPicker, {
        disabled: this.disabled,
        renderContent: (controller) =>
          toReactNode(
            html`<chat-panel-add-popover
              .reactToLit=${this.reactToLit}
              .docId=${this.docId}
              .independentMode=${this.independentMode}
              .addChip=${this.addChip}
              .addImages=${this.addImages}
              .searchMenuConfig=${this.searchMenuConfig}
              .docDisplayConfig=${this.docDisplayConfig}
              .abortController=${controller}
            ></chat-panel-add-popover>`,
          ),
      }),
      true,
    );
  }
}
