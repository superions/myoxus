// SPDX-License-Identifier: MIT
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { notify } from "@myoxus/ui-facade";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { chatI18n } from "../chat-i18n";
import type { ChipState } from "./type";
import { ChatChipView } from "./view";

export class ChatPanelChip extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor state!: ChipState;
  @property({ attribute: false }) accessor name!: string;
  @property({ attribute: false }) accessor tooltip!: string;
  @property({ attribute: false }) accessor icon!: TemplateResult<1>;
  /** Persisted user tag color, not a product UI tone. */
  @property({ attribute: false }) accessor tagColor: string | undefined;
  @property({ attribute: false }) accessor closeable = false;
  @property({ attribute: false }) accessor onChipDelete: () => void = () => {};
  @property({ attribute: false }) accessor onChipClick: () => void = () => {};
  @property({ attribute: false }) accessor onChipRetry:
    (() => Promise<void>) | undefined;

  private async act(action: () => void) {
    const composer = this.closest("ai-chat-composer");
    try {
      await action();
      // Removed badges cannot retain their close button as a focus target.
      if (
        !this.isConnected &&
        composer?.isConnected &&
        document.activeElement === document.body
      )
        composer
          .querySelector<HTMLButtonElement>(
            'button[data-testid="chat-panel-with-button"]',
          )
          ?.focus();
    } catch {
      notify({ title: chatI18n()["com.myoxus.ai.chat-panel.context-error"]() });
    }
  }
  override render() {
    if (!this.reactToLit) return nothing;
    return this.reactToLit(
      createElement(ChatChipView, {
        state: this.state,
        name: this.name,
        tooltip: this.tooltip,
        icon: toReactNode(this.icon),
        tagColor: this.tagColor,
        closeable: this.closeable,
        onAdd: () => void this.act(this.onChipClick),
        onRemove: () => void this.act(this.onChipDelete),
        onRetry: this.onChipRetry
          ? () => void this.act(this.onChipRetry!)
          : undefined,
      }),
      true,
    );
  }
}
