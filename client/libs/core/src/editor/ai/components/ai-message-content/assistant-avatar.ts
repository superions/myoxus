// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactToLit } from "@myoxus/lit-react";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";
import type { ChatStatus } from "../ai-chat-messages";
import { ChatAssistantIdentity } from "../message-chrome";

export class AssistantAvatar extends ShadowlessElement {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: "data-status", reflect: true })
  accessor status: ChatStatus = "idle";
  protected override render() {
    return this.reactToLit
      ? this.reactToLit(createElement(ChatAssistantIdentity), true)
      : nothing;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "chat-assistant-avatar": AssistantAvatar;
  }
}
