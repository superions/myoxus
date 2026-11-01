import "./action-wrapper";

import { WithDisposable } from "@virgultum/editor/global/lit";
import { scrollbarStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import type { EditorHost } from "@virgultum/editor/std";
import { ThemeProvider } from "@virgultum/shared/services";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

import { type ChatAction } from "../../components/ai-chat-messages";
import { createTextRenderer } from "../../components/text-renderer";

export class ActionText extends WithDisposable(LitElement) {
  static override styles = css`
    .original-text {
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      max-height: ${unsafeCSSValue("240px")};
      overflow-y: auto;
    }

    .original-text[data-code="false"] {
      padding: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
      )}
        ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
    }

    .original-text[data-code="true"] {
      padding: 0;
      border: none;
    }

    ${scrollbarStyle(".original-text")}
  `;

  @property({ attribute: false })
  accessor item!: ChatAction;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor isCode = false;

  protected override render() {
    const originalText = this.item.messages[1].content;
    const { isCode } = this;

    return html` <action-wrapper .host=${this.host} .item=${this.item}>
      <div
        class="original-text"
        data-code=${isCode}
        data-testid="original-text"
      >
        ${createTextRenderer({
          customHeading: true,
          theme: this.host.std.get(ThemeProvider).app$,
        })(originalText)}
      </div>
    </action-wrapper>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-text": ActionText;
  }
}
