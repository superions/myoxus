import { createElement } from "react";
import { useI18n } from "@myoxus/i18n";
import { IconButton } from "@myoxus/ui-facade";
import { NewPageIcon as NativeNewPageIcon } from "@myoxus/icons/react";
import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { PlaygroundConversation } from "./view";
import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { ServerService } from "@myoxus/core/modules/server";
import type { AppThemeService } from "@myoxus/core/modules/theme";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { type NotificationService } from "@virgultum/editor/shared/services";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { throttle } from "lodash-es";

import type { AppSidebarConfig } from "../../chat-panel/chat-config";
import { AIProvider } from "../../provider";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { ChatContextValue } from "../ai-chat-content";
import type { AIPlaygroundConfig, AIReasoningConfig } from "../ai-chat-input";
import {
  type AIChatMessages,
  type ChatMessage,
  isChatMessage,
} from "../ai-chat-messages";

const DEFAULT_CHAT_CONTEXT_VALUE: ChatContextValue = {
  quote: "",
  images: [],
  abortController: null,
  messages: [],
  status: "idle",
  error: null,
  markdown: "",
  snapshot: null,
  attachments: [],
  combinedElementsMarkdown: null,
  docs: [],
  html: null,
};

function PlaygroundAddChatAction({
  addChat,
}: {
  addChat: () => Promise<void>;
}) {
  const t = useI18n();
  const label = t["com.myoxus.ai.chat-panel.new-chat"]();
  return createElement(IconButton, {
    icon: createElement(NativeNewPageIcon),
    tooltip: label,
    "aria-label": label,
    onClick: addChat,
  });
}

export class PlaygroundChat extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  // AIChatMessages' public scroll methods act on this actual viewport.
  static override styles = css`
    playground-chat,
    playground-chat > lit-react-portal {
      display: contents;
    }
    playground-chat ai-chat-messages {
      display: block;
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
  `;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor doc!: Store;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({ attribute: false })
  accessor reasoningConfig!: AIReasoningConfig;

  @property({ attribute: false })
  accessor playgroundConfig!: AIPlaygroundConfig;

  @property({ attribute: false })
  accessor appSidebarConfig!: AppSidebarConfig;

  @property({ attribute: false })
  accessor searchMenuConfig!: SearchMenuConfig;

  @property({ attribute: false })
  accessor docDisplayConfig!: DocDisplayConfig;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor serverService!: ServerService;

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor myoxusThemeService!: AppThemeService;

  @property({ attribute: false })
  accessor myoxusWorkspaceDialogService!: WorkspaceDialogService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor aiModelService!: AIModelService;

  @property({ attribute: false })
  accessor addChat!: () => Promise<void>;

  @property({ attribute: false })
  accessor onHistoryCleared!: () => Promise<void>;

  @state()
  accessor isLoading = false;

  @state()
  accessor chatContextValue: ChatContextValue = DEFAULT_CHAT_CONTEXT_VALUE;

  @state()
  accessor embeddingProgress: [number, number] = [0, 0];

  private readonly _chatMessagesRef: Ref<AIChatMessages> =
    createRef<AIChatMessages>();

  // request counter to track the latest request
  private _updateHistoryCounter = 0;

  get messages() {
    return this.chatContextValue.messages.filter(isChatMessage);
  }

  private readonly _initPanel = async () => {
    const userId = (await AIProvider.userInfo)?.id;
    if (!userId) return;

    this.isLoading = true;
    await this._updateHistory();
    this.isLoading = false;
  };

  private readonly _createSession = async () => {
    return this.session;
  };

  private readonly _updateHistory = async () => {
    if (!AIProvider.histories) {
      return;
    }

    const currentRequest = ++this._updateHistoryCounter;

    const sessionId = this.session?.sessionId;
    const histories = sessionId
      ? await AIProvider.histories.chats(
          this.doc.workspace.id,
          sessionId,
          this.doc.id,
        )
      : [];

    // Check if this is still the latest request
    if (currentRequest !== this._updateHistoryCounter) {
      return;
    }

    const messages = (histories?.[0]?.messages || []) as ChatMessage[];

    this.chatContextValue = {
      ...this.chatContextValue,
      messages: messages.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    };

    this._scrollToEnd();
  };

  private readonly onEmbeddingProgressChange = (
    count: Record<ContextEmbedStatus, number>,
  ) => {
    const total = count.finished + count.processing + count.failed;
    this.embeddingProgress = [count.finished, total];
  };

  private readonly updateContext = (context: Partial<ChatContextValue>) => {
    this.chatContextValue = { ...this.chatContextValue, ...context };
  };

  private readonly _scrollToEnd = () => {
    this._chatMessagesRef.value?.scrollToEnd();
  };

  private readonly _throttledScrollToEnd = throttle(this._scrollToEnd, 600);

  override connectedCallback() {
    super.connectedCallback();
    this._initPanel().catch(console.error);
  }

  protected override updated(_changedProperties: PropertyValues) {
    if (
      _changedProperties.has("chatContextValue") &&
      (this.chatContextValue.status === "loading" ||
        this.chatContextValue.status === "error" ||
        this.chatContextValue.status === "success")
    ) {
      setTimeout(this._scrollToEnd, 500);
    }

    if (
      _changedProperties.has("chatContextValue") &&
      this.chatContextValue.status === "transmitting"
    ) {
      this._throttledScrollToEnd();
    }
  }

  override render() {
    const [done, total] = this.embeddingProgress;
    return (
      this.reactToLit?.(
        createElement(
          PlaygroundConversation,
          {
            done,
            total,
            actions: toReactNode(
              html` ${this.reactToLit?.(createElement(PlaygroundAddChatAction, { addChat: this.addChat }), true) ?? nothing}
                <ai-history-clear
                  .reactToLit=${this.reactToLit}
                  .doc=${this.doc}
                  .session=${this.session}
                  .notificationService=${this.notificationService}
                  .onHistoryCleared=${this.onHistoryCleared}
                  .chatContextValue=${this.chatContextValue}
                ></ai-history-clear>`,
            ),
            composer: toReactNode(
              html` <ai-chat-composer
                .reactToLit=${this.reactToLit}
                .host=${this.host}
                .workspaceId=${this.doc.workspace.id}
                .docId=${this.doc.id}
                .session=${this.session}
                .createSession=${this._createSession}
                .chatContextValue=${this.chatContextValue}
                .updateContext=${this.updateContext}
                .onEmbeddingProgressChange=${this.onEmbeddingProgressChange}
                .reasoningConfig=${this.reasoningConfig}
                .playgroundConfig=${this.playgroundConfig}
                .docDisplayConfig=${this.docDisplayConfig}
                .searchMenuConfig=${this.searchMenuConfig}
                .serverService=${this.serverService}
                .notificationService=${this.notificationService}
                .aiToolsConfigService=${this.aiToolsConfigService}
                .myoxusWorkspaceDialogService=${this.myoxusWorkspaceDialogService}
                .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
                .aiModelService=${this.aiModelService}
              ></ai-chat-composer>`,
            ),
          },
          toReactNode(
            html` <ai-chat-messages
              .reactToLit=${this.reactToLit}
              .aiModelService=${this.aiModelService}
              .docDisplayService=${this.docDisplayConfig}
              .peekViewService=${this.peekViewService}
              .onOpenDoc=${this.onOpenDoc}
              ${ref(this._chatMessagesRef)}
              .host=${this.host}
              .workspaceId=${this.doc.workspace.id}
              .docId=${this.doc.id}
              .isHistoryLoading=${this.isLoading}
              .chatContextValue=${this.chatContextValue}
              .session=${this.session}
              .createSession=${this._createSession}
              .updateContext=${this.updateContext}
              .extensions=${this.extensions}
              .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
              .myoxusThemeService=${this.myoxusThemeService}
              .notificationService=${this.notificationService}
              .aiToolsConfigService=${this.aiToolsConfigService}
              .reasoningConfig=${this.reasoningConfig}
              .messages=${this.messages}
            ></ai-chat-messages>`,
          ),
        ),
        true,
      ) ?? nothing
    );
  }
}
