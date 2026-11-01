import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";

import { type ChatAction } from "../../components/ai-chat-messages";

export class ActionImage extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    action-image {
      .action-image-preview {
        margin-block-end: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      }
    }
  `;

  @property({ attribute: false })
  accessor item!: ChatAction;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: "data-testid", reflect: true })
  accessor testId = "action-image";

  protected override render() {
    const images =
      this.item.messages[1]?.attachments ?? this.item.messages[0].attachments;

    return html`<action-wrapper .host=${this.host} .item=${this.item}>
      <div class="action-image-preview">
        ${
          images
            ? html`<chat-content-images
                .images=${images}
                data-testid="original-image"
              ></chat-content-images>`
            : nothing
        }
      </div>
    </action-wrapper>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-image": ActionImage;
  }
}
