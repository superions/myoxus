import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { ServerService } from "@myoxus/core/modules/server";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { i18nTime } from "@myoxus/i18n";
import { InsideModalContext, MyoxusText, Stack } from "@myoxus/ui-facade";
import { createElement } from "react";
import { CopilotResponseActions } from "../components/response-actions";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import {
  CanvasElementType,
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/editor/blocks/surface";
import { ViewExtensionManagerIdentifier } from "@virgultum/editor/ext-loader";
import { ConnectorMode } from "@virgultum/editor/model";
import {
  DocModeProvider,
  NotificationProvider,
  TelemetryProvider,
} from "@virgultum/editor/shared/services";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { throttle } from "lodash-es";
import { nanoid } from "nanoid";

import {
  ChatBlockPeekViewActions,
  constructUserInfoWithMessages,
  queryHistoryMessages,
} from "../_common/chat-actions-handle";
import { type AIChatBlockModel } from "../blocks";
import type { SearchMenuConfig } from "../components/ai-chat-add-context";
import type { DocDisplayConfig } from "../components/ai-chat-chips";
import type { AIReasoningConfig } from "../components/ai-chat-input";
import {
  type ChatMessage,
  ChatMessagesSchema,
  isChatMessage,
  StreamObjectSchema,
} from "../components/ai-chat-messages";
import type { TextRendererOptions } from "../components/text-renderer";
import { AIChatErrorRenderer } from "../messages/error";
import { type AIError, AIProvider } from "../provider";
import { resolveRetryTarget } from "../utils/chat-turn";
import {
  mergeStreamContent,
  mergeStreamObjects,
} from "../utils/stream-objects";
import { ChatPeekConversation } from "../components/message-chrome";
import type { ChatContext } from "./types";
import { calcChildBound } from "./utils";

export class AIChatBlockPeekView extends ShadowlessElement {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  // The modal supplies the viewport; native Facade components own its chrome.
  static override styles = css`
    ai-chat-block-peek-view {
      display: block;
      height: 100%;
      min-height: 0;
    }
    ai-chat-block-peek-view > lit-react-portal {
      display: contents;
    }
  `;

  // These islands still belong to the host's portal tree, but their physical
  // destination is the existing peek modal. Keep native popups in its layer and
  // focus owner; do not create another portal root or compensate with z-index.
  private readonly modalReactToLit: ReactToLit = (
    element,
    rerendering,
    ...args
  ) =>
    this.reactToLit(
      () =>
        createElement(
          InsideModalContext.Provider,
          {
            value: '[data-testid="peek-view-modal"]',
          },
          typeof element === "function" ? element() : element,
        ),
      rerendering,
      ...args,
    );

  private get _modeService() {
    return this.host.std.get(DocModeProvider);
  }

  private get _sessionId() {
    return this.blockModel.props.sessionId;
  }

  private get historyMessagesString() {
    return this.blockModel.props.messages;
  }

  private get blockId() {
    return this.blockModel.id;
  }

  private get rootDocId() {
    return this.blockModel.props.rootDocId;
  }

  private get rootWorkspaceId() {
    return this.blockModel.props.rootWorkspaceId;
  }

  private get _isReasoningActive() {
    return !!this.reasoningConfig.enabled.value;
  }

  private _textRendererOptions: TextRendererOptions = {};

  private _forkBlockId: string | undefined = undefined;

  private readonly _deserializeHistoryChatMessages = (
    historyMessagesString: string,
  ) => {
    try {
      const result = ChatMessagesSchema.safeParse(
        JSON.parse(historyMessagesString),
      );
      if (result.success) {
        return result.data;
      } else {
        return [];
      }
    } catch {
      return [];
    }
  };

  private readonly _constructBranchChatBlockMessages = async (
    rootWorkspaceId: string,
    forkSessionId: string,
    docId?: string,
  ) => {
    const currentUserInfo = await AIProvider.userInfo;
    const forkMessages = (await queryHistoryMessages(
      rootWorkspaceId,
      forkSessionId,
      docId,
    )) as ChatMessage[];
    const forkLength = forkMessages.length;
    const historyLength = this._historyMessages.length;

    if (!forkLength || forkLength <= historyLength) {
      return constructUserInfoWithMessages(forkMessages, currentUserInfo);
    }

    // Update history messages with the fork messages, keep user info
    const historyMessages = this._historyMessages.map((message, idx) => {
      return {
        ...message,
        id: forkMessages[idx]?.id ?? message.id,
        params: forkMessages[idx]?.params,
        attachments: [],
        generatedFiles: forkMessages[idx]?.generatedFiles ?? [],
      };
    });

    const currentChatMessages = constructUserInfoWithMessages(
      forkMessages.slice(historyLength),
      currentUserInfo,
    );
    return [...historyMessages, ...currentChatMessages];
  };

  private readonly _resetContext = () => {
    const { abortController } = this.chatContext;
    if (abortController) {
      abortController.abort();
    }

    this.updateContext({
      status: "idle",
      error: null,
      images: [],
      abortController: null,
      messages: [],
    });
    this._forkBlockId = undefined;
  };

  private readonly initSession = async () => {
    const session = await AIProvider.session?.getSession(
      this.rootWorkspaceId,
      this._sessionId,
    );
    this.session = session ?? null;
  };

  private readonly createForkSession = async () => {
    if (this.forkSession) {
      return this.forkSession;
    }
    const lastMessage = this._historyMessages.at(-1);
    if (!lastMessage) return;

    const { store } = this.host;
    const forkSessionId = await AIProvider.forkChat?.({
      workspaceId: store.workspace.id,
      docId: store.id,
      sessionId: this._sessionId,
      latestMessageId: lastMessage.id,
    });
    if (forkSessionId) {
      const session = await AIProvider.session?.getSession(
        this.rootWorkspaceId,
        forkSessionId,
      );
      this.forkSession = session ?? null;
    }
    return this.forkSession;
  };

  private readonly _onChatSuccess = async () => {
    if (!this._forkBlockId) {
      await this._createForkChatBlock();
    }
    // Update new chat block messages if there are contents returned from AI
    await this.updateChatBlockMessages();
  };

  /**
   * Create a new AI chat block based on the current session and history messages
   */
  private readonly _createForkChatBlock = async () => {
    // Only create AI chat block in edgeless mode
    const mode = this._modeService.getEditorMode();
    if (mode !== "edgeless") {
      return;
    }

    // If there is already a chat block, do not create a new one
    if (this._forkBlockId) {
      return;
    }

    // If there is no session id or chat messages, do not create a new chat block
    const forkSessionId = this.forkSession?.sessionId;
    if (!forkSessionId || !this.chatContext.messages.length) {
      return;
    }

    const { store } = this.host;
    // create a new AI chat block
    const surfaceBlock = store
      .getAllModels()
      .find((block) => block.flavour === "myoxus:surface");
    if (!surfaceBlock) {
      return;
    }

    // Get fork session messages
    const { rootWorkspaceId, rootDocId } = this;
    const messages = await this._constructBranchChatBlockMessages(
      rootWorkspaceId,
      forkSessionId,
      rootDocId,
    );
    if (!messages.length) {
      return;
    }

    const bound = calcChildBound(this.blockModel, this.host.std);

    const crud = this.host.std.get(EdgelessCRUDIdentifier);
    const forkBlockId = crud.addBlock(
      "myoxus:embed-ai-chat",
      {
        xywh: bound.serialize(),
        messages: JSON.stringify(messages),
        sessionId: forkSessionId,
        rootWorkspaceId: rootWorkspaceId,
        rootDocId: rootDocId,
      },
      surfaceBlock.id,
    );

    if (!forkBlockId) {
      return;
    }
    this._forkBlockId = forkBlockId;

    // Connect the parent chat block to the AI chat block
    crud.addElement(CanvasElementType.CONNECTOR, {
      mode: ConnectorMode.Curve,
      controllers: [],
      source: { id: this.blockId },
      target: { id: forkBlockId },
    });

    const telemetryService = this.host.std.getOptional(TelemetryProvider);
    telemetryService?.track("CanvasElementAdded", {
      control: "conversation",
      page: "whiteboard editor",
      module: "canvas",
      segment: "whiteboard",
      type: "chat block",
      category: "branch",
    });
  };

  /**
   * Update the current chat messages with the new message
   */
  updateChatBlockMessages = async () => {
    const forkSessionId = this.forkSession?.sessionId;
    if (!this._forkBlockId || !forkSessionId) {
      return;
    }

    const { store } = this.host;
    const chatBlock = store.getBlock(this._forkBlockId);
    if (!chatBlock) return;

    // Get fork session messages
    const { rootWorkspaceId, rootDocId } = this;
    const messages = await this._constructBranchChatBlockMessages(
      rootWorkspaceId,
      forkSessionId,
      rootDocId,
    );
    if (!messages.length) {
      return;
    }
    store.updateBlock(chatBlock.model, {
      messages: JSON.stringify(messages),
    });
  };

  updateContext = (context: Partial<ChatContext>) => {
    this.chatContext = { ...this.chatContext, ...context };
  };

  private readonly onEmbeddingProgressChange = (
    count: Record<ContextEmbedStatus, number>,
  ) => {
    const total = count.finished + count.processing + count.failed;
    this.embeddingProgress = [count.finished, total];
  };

  /**
   * Clean current chat messages and delete the newly created AI chat block
   */
  private readonly _onHistoryCleared = async () => {
    const { _forkBlockId, host } = this;
    if (_forkBlockId) {
      const surface = getSurfaceBlock(host.store);
      const crud = host.std.get(EdgelessCRUDIdentifier);
      const chatBlock = host.store.getBlock(_forkBlockId)?.model;
      if (chatBlock) {
        const connectors = surface?.getConnectors(chatBlock.id);
        host.store.transact(() => {
          // Delete the AI chat block
          crud.removeElement(_forkBlockId);
          // Delete the connectors
          connectors?.forEach((connector) => {
            crud.removeElement(connector.id);
          });
        });
      }
    }
    this._resetContext();
  };

  private readonly _scrollToEnd = () => {
    requestAnimationFrame(() => {
      if (!this._chatMessagesContainer) return;
      this._chatMessagesContainer.scrollTo({
        top: this._chatMessagesContainer.scrollHeight,
        behavior: "smooth",
      });
    });
  };

  private readonly _throttledScrollToEnd = throttle(this._scrollToEnd, 600);

  // Keep retry ownership independent of delayed composer props and old callbacks.
  private retryController: AbortController | null = null;

  override disconnectedCallback() {
    this.retryController?.abort();
    this.retryController = null;
    this.chatContext.abortController?.abort();
    super.disconnectedCallback();
  }

  retry = async () => {
    if (
      !this.isConnected ||
      (this.retryController && !this.retryController.signal.aborted) ||
      ["loading", "transmitting"].includes(this.chatContext.status) ||
      !AIProvider.actions.chat ||
      !AIProvider.histories
    )
      return;
    const forkSessionId = this.forkSession?.sessionId,
      blockId = this._forkBlockId;
    const previous = this.chatContext.messages,
      last = previous.at(-1);
    if (!blockId || !forkSessionId || !last || last.role !== "assistant")
      return;
    const abortController = new AbortController(),
      requestId = nanoid();
    const { store } = this.host,
      modelId = this.aiModelService.effectiveModelId;
    const reasoning = this.aiModelService.reasoningAvailable
      ? this._isReasoningActive
      : undefined;
    const toolsConfig = this.aiToolsConfigService.config.value;
    this.retryController = abortController;
    const isCurrent = () =>
      this.isConnected &&
      this.retryController === abortController &&
      !abortController.signal.aborted &&
      this.host.store === store &&
      this.forkSession?.sessionId === forkSessionId &&
      this._forkBlockId === blockId &&
      (!this.chatContext.abortController ||
        this.chatContext.abortController === abortController);
    let sawOutput = false;
    this.updateContext({ status: "loading", error: null, abortController });
    try {
      const history = await AIProvider.histories.chats(
        store.workspace.id,
        forkSessionId,
      );
      if (!isCurrent()) return;
      const { user, response, expectedStreamId } = resolveRetryTarget(
        previous,
        (history?.[0]?.messages ?? []) as ChatMessage[],
      );
      let requestMessages = [
        ...previous.slice(0, -1),
        {
          ...last,
          id: response?.id ?? "",
          content: "",
          streamObjects: [],
          params: { requestId },
        },
      ];
      this.updateContext({
        messages: requestMessages,
      });

      const stream = await AIProvider.actions.chat({
        sessionId: forkSessionId,
        retry: true,
        requestId,
        messageId: user.id,
        responseId: response?.id,
        expectedStreamId,
        docId: store.id,
        workspaceId: store.workspace.id,
        host: this.host,
        stream: true,
        signal: abortController.signal,
        where: "ai-chat-block",
        control: "chat-send",
        modelId,
        reasoning,
        toolsConfig,
      });

      for await (const text of stream) {
        if (!isCurrent()) return;
        const messages = requestMessages.slice(0);
        const last = messages.at(-1);
        if (last && isChatMessage(last)) {
          sawOutput = true;
          try {
            const parsed = StreamObjectSchema.parse(JSON.parse(text));
            const streamObjects = mergeStreamObjects([
              ...(last.streamObjects ?? []),
              parsed,
            ]);
            messages[messages.length - 1] = {
              ...last,
              streamObjects,
            };
          } catch {
            messages[messages.length - 1] = {
              ...last,
              content: last.content + text,
            };
          }
          requestMessages = messages;
          this.updateContext({ messages, status: "transmitting" });
        }
      }

      if (!isCurrent()) return;
      const finalHistory = await AIProvider.histories.chats(
        store.workspace.id,
        forkSessionId,
      );
      if (!isCurrent()) return;
      const current = (
        (finalHistory?.[0]?.messages ?? []) as ChatMessage[]
      ).find(
        (message) =>
          message.role === "assistant" &&
          message.params?.requestId === requestId &&
          message.params?.responseTo === user.id,
      );
      if (!current)
        throw new Error(
          "The regenerated response identity could not be reconciled",
        );
      this.updateContext({
        status: "success",
        messages: [
          ...requestMessages.slice(0, -1),
          {
            ...requestMessages.at(-1)!,
            id: current.id,
            params: current.params,
          },
        ],
      });
      // Update new chat block messages if there are contents returned from AI
      await this.updateChatBlockMessages();
    } catch (error) {
      if (isCurrent())
        this.updateContext({
          status: "error",
          error: error as AIError,
          ...(!sawOutput ? { messages: previous } : {}),
        });
    } finally {
      if (isCurrent() && this.chatContext.abortController === abortController)
        this.updateContext({ abortController: null });
      if (this.retryController === abortController) this.retryController = null;
    }
  };

  CurrentMessages = (currentMessages: ChatMessage[]) => {
    if (!currentMessages.length) {
      return html``;
    }

    const { host } = this;
    const actions = ChatBlockPeekViewActions;

    return html`${repeat(
      currentMessages,
      (_, index) => index,
      (message, idx) => {
        const { status, error } = this.chatContext;
        const isAssistantMessage = message.role === "assistant";
        const isLastReply =
          idx === currentMessages.length - 1 && isAssistantMessage;
        const messageState =
          isLastReply && (status === "transmitting" || status === "loading")
            ? "generating"
            : "finished";
        const shouldRenderError = isLastReply && status === "error" && !!error;
        const isNotReady = status === "transmitting" || status === "loading";
        const shouldRenderCopyMore =
          isAssistantMessage && !(isLastReply && isNotReady);
        const markdown = message.streamObjects?.length
          ? mergeStreamContent(message.streamObjects)
          : message.content;

        if (status === "loading" && isLastReply) {
          return html`<ai-loading
            .reactToLit=${this.modalReactToLit}
          ></ai-loading>`;
        }

        const notificationService = this.host.std.get(NotificationProvider);

        return this.modalReactToLit(
          createElement(
            Stack,
            { gap: "xs" },
            toReactNode(html`
              <ai-chat-block-message
                .reactToLit=${this.modalReactToLit}
                .host=${host}
                .state=${messageState}
                .message=${message}
                .textRendererOptions=${this._textRendererOptions}
                .docDisplayConfig=${this.docDisplayConfig}
                .peekViewService=${this.peekViewService}
              ></ai-chat-block-message>
              ${shouldRenderError ? AIChatErrorRenderer(error, host, this.modalReactToLit) : nothing}
            `),
            shouldRenderCopyMore
              ? createElement(CopilotResponseActions, {
                  host,
                  sessionId: this.forkSession?.sessionId,
                  actions,
                  content: markdown,
                  messageId: message.id ?? undefined,
                  generatedFiles: message.generatedFiles,
                  exportable:
                    !this.host.store.readonly &&
                    !!markdown.trim() &&
                    (message.params?.streamStatus === undefined ||
                      message.params?.streamStatus === "done"),
                  retry: isLastReply ? () => this.retry() : undefined,
                  notificationService,
                })
              : null,
          ),
          true,
        );
      },
    )}`;
  };

  override connectedCallback() {
    super.connectedCallback();
    this.initSession().catch(console.error);
    const extensions = this.host.std
      .get(ViewExtensionManagerIdentifier)
      .get("preview-page");

    this._textRendererOptions = {
      extensions,
      myoxusFeatureFlagService: this.myoxusFeatureFlagService,
    };
    this._historyMessages = this._deserializeHistoryChatMessages(
      this.historyMessagesString,
    );
    const { rootWorkspaceId, _sessionId } = this;
    queryHistoryMessages(rootWorkspaceId, _sessionId)
      .then((messages) => {
        this._historyMessages = this._historyMessages.map((message, idx) => {
          return {
            ...message,
            attachments: messages[idx]?.attachments ?? [],
            generatedFiles: messages[idx]?.generatedFiles ?? [],
          };
        });
      })
      .catch((err: Error) => {
        console.error("Query history messages failed", err);
      });
  }

  override firstUpdated() {
    this._scrollToEnd();
  }

  protected override updated(changedProperties: PropertyValues) {
    if (
      changedProperties.has("chatContext") &&
      (this.chatContext.status === "loading" ||
        this.chatContext.status === "error" ||
        this.chatContext.status === "success")
    ) {
      setTimeout(this._scrollToEnd, 500);
    }

    if (
      changedProperties.has("chatContext") &&
      this.chatContext.status === "transmitting"
    ) {
      this._throttledScrollToEnd();
    }
  }

  override render() {
    const { host, _historyMessages } = this;
    if (!_historyMessages.length) {
      return nothing;
    }

    const latestHistoryMessage = _historyMessages[_historyMessages.length - 1];
    const latestMessageCreatedAt = latestHistoryMessage.createdAt;
    const { chatContext, updateContext, _textRendererOptions } = this;

    const { messages: currentChatMessages } = chatContext;
    const notificationService = this.host.std.get(NotificationProvider);

    return this.modalReactToLit(
      createElement(
        ChatPeekConversation,
        {
          viewportRef: this._setMessagesViewport,
          header: toReactNode(html`
            <ai-history-clear
              .reactToLit=${this.modalReactToLit}
              .doc=${this.host.store}
              .session=${this.forkSession}
              .onHistoryCleared=${this._onHistoryCleared}
              .chatContextValue=${chatContext}
              .notificationService=${notificationService}
            ></ai-history-clear>
          `),
          composer: toReactNode(html`
            <ai-chat-composer
              .reactToLit=${this.modalReactToLit}
              .host=${host}
              .workspaceId=${this.rootWorkspaceId}
              .docId=${this.rootDocId}
              .session=${this.forkSession ?? this.session}
              .createSession=${this.createForkSession}
              .chatContextValue=${chatContext}
              .updateContext=${updateContext}
              .onEmbeddingProgressChange=${this.onEmbeddingProgressChange}
              .docDisplayConfig=${this.docDisplayConfig}
              .searchMenuConfig=${this.searchMenuConfig}
              .myoxusWorkspaceDialogService=${this.myoxusWorkspaceDialogService}
              .notificationService=${notificationService}
              .aiToolsConfigService=${this.aiToolsConfigService}
              .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
              .onChatSuccess=${this._onChatSuccess}
              .trackOptions=${{
                where: "ai-chat-block",
                control: "chat-send",
              }}
              .portalContainer=${this.parentElement}
              .reasoningConfig=${this.reasoningConfig}
              .serverService=${this.serverService}
              .aiModelService=${this.aiModelService}
            ></ai-chat-composer>
          `),
        },
        toReactNode(html`
          <ai-chat-block-messages
            .reactToLit=${this.modalReactToLit}
            .host=${host}
            .messages=${_historyMessages}
            .showGeneratedFiles=${true}
            .docDisplayConfig=${this.docDisplayConfig}
            .peekViewService=${this.peekViewService}
            .textRendererOptions=${_textRendererOptions}
          ></ai-chat-block-messages>
        `),
        createElement(
          MyoxusText,
          {
            component: "time",
            dateTime: latestMessageCreatedAt,
            typographySlot: "caption",
            tone: "secondary",
            ta: "center",
          },
          i18nTime(latestMessageCreatedAt, {
            relative: { max: [1, "day"], accuracy: "minute", weekday: true },
            absolute: { accuracy: "second" },
          }),
        ),
        toReactNode(this.CurrentMessages(currentChatMessages)),
      ),
      true,
    );
  }

  private _chatMessagesContainer: HTMLDivElement | null = null;
  private readonly _setMessagesViewport = (element: HTMLDivElement | null) => {
    this._chatMessagesContainer = element;
    if (element) this._scrollToEnd();
  };

  @property({ attribute: false })
  accessor blockModel!: AIChatBlockModel;

  @property({ attribute: false }) accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor reasoningConfig!: AIReasoningConfig;

  @property({ attribute: false })
  accessor serverService!: ServerService;

  @property({ attribute: false })
  accessor docDisplayConfig!: DocDisplayConfig;

  @property({ attribute: false })
  accessor searchMenuConfig!: SearchMenuConfig;

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor myoxusWorkspaceDialogService!: WorkspaceDialogService;

  @property({ attribute: false })
  accessor aiDraftService!: AIDraftService;

  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor aiModelService!: AIModelService;

  @state()
  accessor _historyMessages: ChatMessage[] = [];

  @state()
  accessor chatContext: ChatContext = {
    status: "idle",
    error: null,
    images: [],
    abortController: null,
    messages: [],
  };

  @state()
  accessor embeddingProgress: [number, number] = [0, 0];

  @state()
  accessor session: CopilotChatHistoryFragment | null | undefined;

  @state()
  accessor forkSession: CopilotChatHistoryFragment | null | undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-chat-block-peek-view": AIChatBlockPeekView;
  }
}

export const AIChatBlockPeekViewTemplate = (
  blockModel: AIChatBlockModel,
  host: EditorHost,
  docDisplayConfig: DocDisplayConfig,
  searchMenuConfig: SearchMenuConfig,
  reasoningConfig: AIReasoningConfig,
  serverService: ServerService,
  myoxusFeatureFlagService: FeatureFlagService,
  myoxusWorkspaceDialogService: WorkspaceDialogService,
  aiDraftService: AIDraftService,
  aiToolsConfigService: AIToolsConfigService,
  aiModelService: AIModelService,
  reactToLit: ReactToLit,
  peekViewService: PeekViewService,
) => {
  return html`<ai-chat-block-peek-view
    .reactToLit=${reactToLit}
    .blockModel=${blockModel}
    .peekViewService=${peekViewService}
    .host=${host}
    .docDisplayConfig=${docDisplayConfig}
    .searchMenuConfig=${searchMenuConfig}
    .reasoningConfig=${reasoningConfig}
    .serverService=${serverService}
    .myoxusFeatureFlagService=${myoxusFeatureFlagService}
    .myoxusWorkspaceDialogService=${myoxusWorkspaceDialogService}
    .aiDraftService=${aiDraftService}
    .aiToolsConfigService=${aiToolsConfigService}
    .aiModelService=${aiModelService}
  ></ai-chat-block-peek-view>`;
};
