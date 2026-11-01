import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { ReactToLit } from "@myoxus/lit-react";
import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { ServerService } from "@myoxus/core/modules/server";
import type { AppThemeService } from "@myoxus/core/modules/theme";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { DeleteIcon, NewPageIcon } from "@myoxus/icons/lit";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { type NotificationService } from "@virgultum/editor/shared/services";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { throttle } from "lodash-es";

import type { AppSidebarConfig } from "../../chat-panel/chat-config";
import { AIProvider } from "../../provider";
import { HISTORY_IMAGE_ACTIONS } from "../../utils/history-image-actions";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { ChatContextValue } from "../ai-chat-content";
import type { AIPlaygroundConfig, AIReasoningConfig } from "../ai-chat-input";
import {
  type AIChatMessages,
  type ChatAction,
  type ChatMessage,
  type HistoryMessage,
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

export class PlaygroundChat extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  static override styles = css`
    playground-chat {
      .chat-panel-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 0 ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      }

      .chat-panel-title {
        background: ${unsafeCSSVar("backgroundPrimaryColor")};
        position: relative;
        padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")} 0;
        width: 100%;
        min-height: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-xs))",
        )};
        display: flex;
        justify-content: space-between;
        align-items: center;
        z-index: 1;

        .chat-panel-title-text {
          color: ${unsafeCSSVar("textSecondaryColor")};
        }

        svg {
          width: ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-2xs))",
          )};
          height: ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-2xs))",
          )};
          color: ${unsafeCSSVar("iconSecondary")};
        }
      }

      ai-chat-messages {
        flex: 1;
        overflow-y: auto;
      }

      .chat-panel-hints {
        margin: 0 ${unsafeCSSValue("var(--mantine-spacing-xs)")};
        padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")}
          ${unsafeCSSValue("var(--mantine-spacing-md)")};
        border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
        border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
          ${unsafeCSSVar("borderColor")};
        cursor: pointer;
      }

      .chat-panel-hints :first-child {
        color: ${unsafeCSSVar("textPrimaryColor")};
      }

      .chat-panel-hints :nth-child(2) {
        color: ${unsafeCSSVar("textSecondaryColor")};
      }

      .chat-panel-add,
      .chat-panel-delete {
        cursor: pointer;
        padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .chat-panel-add {
        margin-left: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
        margin-right: auto;
      }

      .chat-panel-delete {
        margin-left: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
        display: none;
      }

      .chat-panel-add:hover svg,
      .chat-panel-delete:hover svg {
        color: ${unsafeCSSVar("primaryColor")};
      }

      ${fontSMStyle(".chat-panel-title-text")}
      ${fontSMStyle(".chat-panel-hints")}
    }
  `;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor doc!: Store;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

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
    return this.chatContextValue.messages.filter((item) => {
      return (
        isChatMessage(item) ||
        item.messages?.length === 3 ||
        (HISTORY_IMAGE_ACTIONS.includes(item.action) &&
          item.messages?.length === 2)
      );
    });
  }

  get showActions() {
    return false;
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
    const [histories, actions] = await Promise.all([
      sessionId
        ? AIProvider.histories.chats(
            this.doc.workspace.id,
            sessionId,
            this.doc.id,
          )
        : Promise.resolve([]),
      this.doc.id && this.showActions
        ? AIProvider.histories.actions(this.doc.workspace.id, this.doc.id)
        : Promise.resolve([]),
    ]);

    // Check if this is still the latest request
    if (currentRequest !== this._updateHistoryCounter) {
      return;
    }

    const chatActions = (actions || []) as ChatAction[];
    const messages: HistoryMessage[] = chatActions;

    const chatMessages = (histories?.[0]?.messages || []) as ChatMessage[];
    messages.push(...chatMessages);

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
    const isEmbedding = total > 0 && done < total;

    return html`<div class="chat-panel-container">
      <div class="chat-panel-title">
        <div class="chat-panel-title-text">
          ${
            isEmbedding
              ? html`<span data-testid="chat-panel-embedding-progress"
                  >Embedding ${done}/${total}</span
                >`
              : "Myoxus AI"
          }
        </div>
        <div class="chat-panel-add" @click=${this.addChat}>
          ${NewPageIcon()}
          <myoxus-tooltip>Add chat</myoxus-tooltip>
        </div>
        <ai-history-clear
          .doc=${this.doc}
          .session=${this.session}
          .notificationService=${this.notificationService}
          .onHistoryCleared=${this._updateHistory}
          .chatContextValue=${this.chatContextValue}
        ></ai-history-clear>
        <div class="chat-panel-delete">${DeleteIcon()}</div>
      </div>
      <ai-chat-messages
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
      ></ai-chat-messages>
      <ai-chat-composer
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
      ></ai-chat-composer>
    </div>`;
  }
}
