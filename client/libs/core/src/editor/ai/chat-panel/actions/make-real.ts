import "./action-wrapper";

import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { type ChatAction } from "../../components/ai-chat-messages";
import { createIframeRenderer } from "../../messages/wrapper";

export class ActionMakeReal extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    action-make-real {
      .action-make-real-preview {
        margin-block-end: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      }
    }
  `;

  @property({ attribute: false })
  accessor item!: ChatAction;

  @property({ attribute: false })
  accessor host!: EditorHost;

  protected override render() {
    const answer = this.item.messages[2].content;
    return html`<action-wrapper .host=${this.host} .item=${this.item}>
      <div class="action-make-real-preview">
        ${createIframeRenderer(this.host)(answer, "finished")}
      </div>
    </action-wrapper>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-make-real": ActionMakeReal;
  }
}
