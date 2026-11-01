import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";

import { type ChatAction } from "../../components/ai-chat-messages";

export class ActionImageToText extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    action-image-to-text {
      .action-image-to-text-preview {
        margin-block-end: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      }
    }
  `;

  @property({ attribute: false })
  accessor item!: ChatAction;

  @property({ attribute: false })
  accessor host!: EditorHost;

  protected override render() {
    const answer = this.item.messages[1].attachments;

    return html`<action-wrapper .host=${this.host} .item=${this.item}>
      <div class="action-image-to-text-preview">
        ${
          answer
            ? html`<chat-content-images
                data-testid="original-images"
                .images=${answer}
              ></chat-content-images>`
            : nothing
        }
      </div>
    </action-wrapper>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-image-to-text": ActionImageToText;
  }
}
