// SPDX-License-Identifier: MIT
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";
import type { ChatMessage } from "../../components/ai-chat-messages";
import {
  ChatMessageSurface,
  ChatUserIdentity,
} from "../../components/message-chrome";

export class ChatMessageUser extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor item!: ChatMessage;
  @property({ attribute: false }) accessor avatarUrl = "";
  @property({ attribute: false }) accessor userName = "";
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "chat-message-user";
  protected override render() {
    if (!this.reactToLit) return nothing;
    return this.reactToLit(
      createElement(
        ChatMessageSurface,
        {
          assistant: false,
          identity: createElement(ChatUserIdentity, {
            avatarUrl: this.avatarUrl,
            name: this.userName,
          }),
        },
        toReactNode(html`
          ${this.item.attachments?.length ? html`<chat-content-images .images=${this.item.attachments}></chat-content-images>` : nothing}
          <chat-content-pure-text
            .reactToLit=${this.reactToLit}
            .text=${this.item.content}
          ></chat-content-pure-text>
        `),
      ),
      true,
    );
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "chat-message-user": ChatMessageUser;
  }
}
