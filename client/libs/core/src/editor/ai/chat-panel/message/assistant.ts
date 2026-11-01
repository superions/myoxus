import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { createElement } from "react";
import {
  ChatAssistantIdentity,
  ChatMessageSurface,
} from "../../components/message-chrome";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { AppThemeService } from "@myoxus/core/modules/theme";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import type { Signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { isInsidePageEditor } from "@virgultum/editor/shared/utils";
import {
  type BlockStdScope,
  type EditorHost,
  ShadowlessElement,
} from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/shared/services";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";

import {
  EdgelessEditorActions,
  PageEditorActions,
} from "../../_common/chat-actions-handle";
import type { DocDisplayConfig } from "../../components/ai-chat-chips";
import {
  type ChatMessage,
  type ChatStatus,
  isChatMessage,
  type StreamObject,
} from "../../components/ai-chat-messages";
import { AIChatErrorRenderer } from "../../messages/error";
import { type AIError } from "../../provider";
import { mergeStreamContent } from "../../utils/stream-objects";

export class ChatMessageAssistant extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor std: BlockStdScope | null | undefined;

  @property({ attribute: false })
  accessor item!: ChatMessage;

  @property({ attribute: false })
  accessor isLast: boolean = false;

  @property({ attribute: "data-status", reflect: true })
  accessor status: ChatStatus = "idle";

  @property({ attribute: false })
  accessor error: AIError | null = null;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor myoxusThemeService!: AppThemeService;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor retry!: () => void;

  @property({ attribute: "data-testid", reflect: true })
  accessor testId = "chat-message-assistant";

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  get state() {
    const { isLast, status } = this;
    return isLast
      ? status !== "loading" && status !== "transmitting"
        ? "finished"
        : "generating"
      : "finished";
  }

  // The first reasoning disclosure shares the speaker row; later tool/reasoning
  // sections retain their own place in the provider's ordered stream.
  private get headerInReasoning() {
    return this.item.streamObjects?.[0]?.type === "reasoning";
  }

  renderHeader() {
    const isWithDocs =
      "content" in this.item &&
      this.item.content &&
      this.item.content.includes("[^") &&
      /\[\^\d+\]:{"type":"doc","docId":"[^"]+"}/.test(this.item.content);

    return createElement(ChatAssistantIdentity, { withDocs: !!isWithDocs });
  }

  renderContent() {
    const { host, item, isLast, status, error } = this;
    const { streamObjects, content } = item;
    const shouldRenderError = isLast && status === "error" && !!error;

    return html`
      ${this.renderImages()}
      ${
        streamObjects?.length
          ? this.renderStreamObjects(streamObjects)
          : this.renderRichText(content)
      }
      ${shouldRenderError ? AIChatErrorRenderer(error, host, this.reactToLit) : nothing}
      ${this.renderEditorActions()}
    `;
  }

  private renderImages() {
    const { item } = this;
    if (!item.attachments) return nothing;

    return html`<chat-content-images
      .images=${item.attachments}
    ></chat-content-images>`;
  }

  private renderStreamObjects(answer: StreamObject[]) {
    return html`<chat-content-stream-objects
      .reactToLit=${this.reactToLit}
      .reasoningIdentity=${this.headerInReasoning ? this.renderHeader() : undefined}
      .host=${this.host}
      .std=${this.std}
      .answer=${answer}
      .state=${this.state}
      .width=${this.width}
      .extensions=${this.extensions}
      .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
      .notificationService=${this.notificationService}
      .theme=${this.myoxusThemeService.appTheme.themeSignal}
      .independentMode=${this.independentMode}
      .docDisplayService=${this.docDisplayService}
      .peekViewService=${this.peekViewService}
      .onOpenDoc=${this.onOpenDoc}
    ></chat-content-stream-objects>`;
  }

  private renderRichText(text: string) {
    return html`<chat-content-rich-text
      .text=${text}
      .state=${this.state}
      .extensions=${this.extensions}
      .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
      .theme=${this.myoxusThemeService.appTheme.themeSignal}
    ></chat-content-rich-text>`;
  }

  private renderEditorActions() {
    const { item, isLast, status, host, session } = this;

    if (!isChatMessage(item) || item.role !== "assistant") return nothing;

    if (
      isLast &&
      status !== "success" &&
      status !== "idle" &&
      status !== "error"
    )
      return nothing;

    const { content, streamObjects, id: messageId } = item;
    const markdown = streamObjects?.length
      ? mergeStreamContent(streamObjects)
      : content;

    const actions = host
      ? isInsidePageEditor(host)
        ? PageEditorActions
        : EdgelessEditorActions
      : null;

    const showActions = host && !!markdown && !this.independentMode;

    return html`
      <chat-copy-more
        .reactToLit=${this.reactToLit}
        .host=${host}
        .session=${session}
        .actions=${showActions ? actions : []}
        .content=${markdown}
        .isLast=${isLast}
        .messageId=${messageId}
        .generatedFiles=${item.generatedFiles ?? []}
        .exportable=${!!markdown.trim() && !host?.store.readonly && !(isLast && status === "error") && (item.params?.streamStatus === undefined || item.params?.streamStatus === "done")}
        .withMargin=${true}
        .retry=${() => this.retry()}
        .notificationService=${this.notificationService}
      ></chat-copy-more>
    `;
  }

  protected override render() {
    if (!this.reactToLit) return nothing;
    const { isLast, status } = this;

    if (isLast && status === "loading") {
      return html`<ai-loading .reactToLit=${this.reactToLit}></ai-loading>`;
    }

    // Stopping before the first token can leave a stored empty assistant turn.
    // Keep its retry target, but do not present an answer identity with no answer.
    if (
      this.state === "finished" &&
      !(isLast && status === "error" && this.error) &&
      !this.item.content.trim() &&
      !this.item.streamObjects?.length &&
      !this.item.attachments?.length
    ) {
      return this.renderEditorActions();
    }

    return this.reactToLit(
      createElement(
        ChatMessageSurface,
        {
          assistant: true,
          identity: this.headerInReasoning ? undefined : this.renderHeader(),
        },
        toReactNode(this.renderContent()),
      ),
      true,
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-message-assistant": ChatMessageAssistant;
  }
}
