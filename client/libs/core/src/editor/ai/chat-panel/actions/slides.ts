import "./action-wrapper";
import "../../messages/slides-renderer";

import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";

import { type ChatAction } from "../../components/ai-chat-messages";

export class ActionSlides extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    action-slides {
      .action-slides-preview {
        margin-block-end: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      }
    }
  `;

  @property({ attribute: false })
  accessor item!: ChatAction;

  @property({ attribute: false })
  accessor host!: EditorHost;

  protected override render() {
    const answer = this.item.messages[2]?.content;
    if (!answer) return nothing;

    return html`<action-wrapper .host=${this.host} .item=${this.item}>
      <div class="action-slides-preview">
        <ai-slides-renderer
          .text=${answer}
          .host=${this.host}
        ></ai-slides-renderer>
      </div>
    </action-wrapper>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-slides": ActionSlides;
  }
}
