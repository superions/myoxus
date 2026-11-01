import type { TextRendererOptions } from "@myoxus/core/editor/ai/components/text-renderer";
import type { ReactToLit } from "@myoxus/lit-react";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import {
  NotificationProvider,
  ThemeProvider,
} from "@virgultum/shared/services";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";

import {
  type ChatMessage,
  type StreamObject,
} from "../../../components/ai-chat-messages";
import { UserInfoTemplate } from "./user-info";

// Native descendants consume the host's Mantine stylesheet. Retained block
// preview geometry stays scoped to this light-DOM host.
export class AIChatBlockMessage extends ShadowlessElement {
  static override styles = css`
    ai-chat-block-message {
      .ai-chat-message {
        display: flex;
        width: 100%;
        flex-direction: column;
        gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
        box-sizing: border-box;
      }

      .ai-chat-content {
        display: block;
        width: calc(
          100% - ${unsafeCSSValue("var(--mantine-spacing-xl)")} -
            ${unsafeCSSValue(
              "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
            )}
        );
        padding-left: calc(
          ${unsafeCSSValue("var(--mantine-spacing-xl)")} +
            ${unsafeCSSValue(
              "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
            )}
        );
      }

      .with-attachments {
        margin-top: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      }

      ${fontSMStyle(".ai-chat-content")}
    }
  `;

  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;

  override render() {
    const {
      content,
      attachments,
      userName,
      userId,
      avatarUrl,
      role,
      streamObjects,
    } = this.message;
    const withAttachments = !!attachments && attachments.length > 0;

    const messageClasses = classMap({
      "with-attachments": withAttachments,
    });

    return html`
      <div class="ai-chat-message">
        ${UserInfoTemplate({ userId, userName, avatarUrl }, role)}
        <div class="ai-chat-content">
          <chat-images .attachments=${attachments}></chat-images>
          <div class=${messageClasses}>
            ${
              streamObjects?.length
                ? this.renderStreamObjects(streamObjects)
                : this.renderRichText(content)
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderStreamObjects(answer: StreamObject[]) {
    const notificationService = this.host.std.get(NotificationProvider);
    return html`<chat-content-stream-objects
      .reactToLit=${this.reactToLit}
      .answer=${answer}
      .host=${this.host}
      .state=${this.state}
      .extensions=${this.textRendererOptions.extensions}
      .myoxusFeatureFlagService=${
        this.textRendererOptions.myoxusFeatureFlagService
      }
      .notificationService=${notificationService}
      .independentMode=${false}
      .theme=${this.host.std.get(ThemeProvider).app$}
    ></chat-content-stream-objects>`;
  }

  private renderRichText(text: string) {
    return html`<chat-content-rich-text
      .text=${text}
      .state=${this.state}
      .extensions=${this.textRendererOptions.extensions}
      .myoxusFeatureFlagService=${
        this.textRendererOptions.myoxusFeatureFlagService
      }
      .theme=${this.host.std.get(ThemeProvider).app$}
    ></chat-content-rich-text>`;
  }

  @property({ attribute: false })
  accessor message!: ChatMessage;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor state: "finished" | "generating" = "finished";

  @property({ attribute: false })
  accessor textRendererOptions: TextRendererOptions = {};
}

export class AIChatBlockMessages extends ShadowlessElement {
  static override styles = css`
    ai-chat-block-messages {
      width: 100%;
      box-sizing: border-box;

      .ai-chat-messages {
        display: flex;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        flex-direction: column;
        gap: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      }
    }
  `;

  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  // Canvas previews retain their bounded rendering; only the interactive peek
  // exposes authenticated downloads from restored message references.
  @property({ attribute: false }) accessor showGeneratedFiles = false;

  override render() {
    return html`<div class="ai-chat-messages">
      ${repeat(
        this.messages,
        (message) => message.id || message.createdAt,
        (message) => {
          return html`
            <ai-chat-block-message
              .reactToLit=${this.reactToLit}
              .host=${this.host}
              .textRendererOptions=${this.textRendererOptions}
              .message=${message}
            ></ai-chat-block-message>
            ${
              this.showGeneratedFiles && message.generatedFiles?.length
                ? html`<chat-copy-more
                    .reactToLit=${this.reactToLit}
                    .host=${this.host}
                    .messageId=${message.id}
                    .generatedFiles=${message.generatedFiles}
                    .notificationService=${this.host.std.get(NotificationProvider)}
                  ></chat-copy-more>`
                : nothing
            }
          `;
        },
      )}
    </div>`;
  }

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor messages: ChatMessage[] = [];

  @property({ attribute: false })
  accessor textRendererOptions: TextRendererOptions = {};
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-chat-block-message": AIChatBlockMessage;
    "ai-chat-block-messages": AIChatBlockMessages;
  }
}
