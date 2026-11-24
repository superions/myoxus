import { StoredChatMessages } from "../blocks/ai-chat-block/components/stored-chat-messages";
import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { ServerService } from "@myoxus/core/modules/server";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { i18nTime } from "@myoxus/i18n";
import { InsideModalContext, MyoxusText, Stack } from "@myoxus/ui-facade";
import { createElement, type ReactNode } from "react";
import { signal } from "@preact/signals-core";
import { CopilotResponseActions } from "../components/response-actions";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import {
  CanvasElementType,
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/editor/blocks/surface";
import { ConnectorMode } from "@virgultum/editor/model";
import {
  DocModeProvider,
  NotificationProvider,
  TelemetryProvider,
} from "@virgultum/editor/shared/services";
import type { EditorHost } from "@virgultum/editor/std";
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
import type { AIChatComposer } from "../components/ai-chat-composer";
import type { AIHistoryClear } from "../components/ai-history-clear";
import type { AIReasoningConfig } from "../components/ai-chat-input";
import {
  type ChatMessage,
  ChatMessagesSchema,
  isChatMessage,
  StreamObjectSchema,
} from "../components/ai-chat-messages";
import { AIChatErrorRenderer } from "../messages/error";
import { type AIError, AIProvider } from "../provider";
import { resolveRetryTarget } from "../utils/chat-turn";
import {
  mergeStreamContent,
  mergeStreamObjects,
} from "../utils/stream-objects";
import {
  ChatLoading,
  ChatPeekConversation,
} from "../components/message-chrome";
import type { ChatContext } from "./types";
import { calcChildBound } from "./utils";

const peekTracking = { where: "ai-chat-block", control: "chat-send" } as const;

type PeekSessionOptions = {
  blockModel: AIChatBlockModel;
  peekViewService: PeekViewService;
  host: EditorHost;
  reasoningConfig: AIReasoningConfig;
  serverService: ServerService;
  docDisplayConfig: DocDisplayConfig;
  searchMenuConfig: SearchMenuConfig;
  myoxusFeatureFlagService: FeatureFlagService;
  myoxusWorkspaceDialogService: WorkspaceDialogService;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
  reactToLit: ReactToLit;
};

export class AIChatBlockPeekSession {
  private readonly revision = signal(0);
  readonly subscribe = (notify: () => void) => this.revision.subscribe(notify);
  readonly getSnapshot = () => this.revision.value;
  private isConnected = false;
  private lifetime = 0;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private parentElement?: HTMLElement;

  readonly blockModel!: AIChatBlockModel;
  readonly peekViewService!: PeekViewService;
  readonly host!: EditorHost;
  readonly reasoningConfig!: AIReasoningConfig;
  readonly serverService!: ServerService;
  readonly docDisplayConfig!: DocDisplayConfig;
  readonly searchMenuConfig!: SearchMenuConfig;
  readonly myoxusFeatureFlagService!: FeatureFlagService;
  readonly myoxusWorkspaceDialogService!: WorkspaceDialogService;
  readonly aiToolsConfigService!: AIToolsConfigService;
  readonly aiModelService!: AIModelService;
  readonly reactToLit!: ReactToLit;

  constructor(options: PeekSessionOptions) {
    Object.assign(this, options);
  }

  private refresh() {
    this.revision.value++;
  }

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

  private get rootWorkspaceId() {
    return this.blockModel.props.rootWorkspaceId;
  }

  private get _isReasoningActive() {
    return !!this.reasoningConfig.enabled.value;
  }

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
    forkSessionId: string,
  ) => {
    const { store } = this.host;
    const currentUserInfo = await AIProvider.userInfo;
    // The fork belongs to the open document, including when its source card was copied.
    const forkMessages = (await queryHistoryMessages(
      store.workspace.id,
      forkSessionId,
      store.id,
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
    const lifetime = this.lifetime;
    const session = await AIProvider.session?.getSession(
      this.rootWorkspaceId,
      this._sessionId,
    );
    if (lifetime !== this.lifetime) return;
    this.session = session ?? null;
    this.refresh();
  };

  private readonly createForkSession = async () => {
    if (this.forkSession) {
      return this.forkSession;
    }
    const lastMessage = this._historyMessages.at(-1);
    if (!lastMessage) return;

    const lifetime = this.lifetime;
    const { store } = this.host;
    const forkSessionId = await AIProvider.forkChat?.({
      workspaceId: store.workspace.id,
      docId: store.id,
      sessionId: this._sessionId,
      latestMessageId: lastMessage.id,
    });
    if (forkSessionId) {
      const session = await AIProvider.session?.getSession(
        store.workspace.id,
        forkSessionId,
      );
      if (lifetime !== this.lifetime) return;
      this.forkSession = session ?? null;
      this.refresh();
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

    const lifetime = this.lifetime;
    const messages =
      await this._constructBranchChatBlockMessages(forkSessionId);
    if (
      !messages.length ||
      lifetime !== this.lifetime ||
      this.forkSession?.sessionId !== forkSessionId ||
      this._forkBlockId ||
      store.readonly ||
      !store.getBlock(this.blockId)
    ) {
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
        rootWorkspaceId: store.workspace.id,
        rootDocId: store.id,
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
    const blockId = this._forkBlockId;
    if (!blockId || !forkSessionId) return;

    const lifetime = this.lifetime;
    const messages =
      await this._constructBranchChatBlockMessages(forkSessionId);
    const { store } = this.host;
    const chatBlock = store.getBlock(blockId);
    if (
      !messages.length ||
      lifetime !== this.lifetime ||
      this._forkBlockId !== blockId ||
      this.forkSession?.sessionId !== forkSessionId ||
      store.readonly ||
      !chatBlock
    ) {
      return;
    }
    store.updateBlock(chatBlock.model, {
      messages: JSON.stringify(messages),
    });
  };

  updateContext = (context: Partial<ChatContext>) => {
    if (!this.isConnected) return;
    this.chatContext = { ...this.chatContext, ...context };
    this.refresh();
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

  private disconnect() {
    this.isConnected = false;
    this.lifetime++;
    this.retryController?.abort();
    this.retryController = null;
    this.chatContext.abortController?.abort();
    this._throttledScrollToEnd.cancel();
    clearTimeout(this.scrollTimer);
    this.parentElement = undefined;
    this._chatMessagesContainer = null;
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

  private renderCurrentMessages(currentMessages: ChatMessage[]): ReactNode {
    const { host } = this;
    const actions = ChatBlockPeekViewActions;

    return currentMessages.map((message, idx) => {
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
        return createElement(ChatLoading, { key: idx });
      }

      const notificationService = this.host.std.get(NotificationProvider);

      return createElement(
        Stack,
        { key: idx, gap: "xs" },
        createElement(StoredChatMessages, {
          host,
          messages: [message],
          state: messageState,
          readOnly: host.store.readonly,
          docDisplayConfig: this.docDisplayConfig,
          peekViewService: this.peekViewService,
        }),
        shouldRenderError
          ? toReactNode(AIChatErrorRenderer(error, host, this.modalReactToLit))
          : null,
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
      );
    });
  }

  connect(anchor: HTMLElement) {
    this.parentElement = anchor;
    this.isConnected = true;
    const lifetime = ++this.lifetime;
    this.initSession().catch(console.error);
    this._historyMessages = this._deserializeHistoryChatMessages(
      this.historyMessagesString,
    );
    this.refresh();
    queryHistoryMessages(this.rootWorkspaceId, this._sessionId)
      .then((messages) => {
        if (lifetime !== this.lifetime) return;
        // History enrichment may be unavailable offline. The saved snapshot
        // already contains readable attachments and completed file references.
        this._historyMessages = this._historyMessages.map((message, index) => ({
          ...message,
          attachments: messages[index]?.attachments ?? message.attachments,
          generatedFiles:
            messages[index]?.generatedFiles ?? message.generatedFiles,
        }));
        this.refresh();
      })
      .catch((error: Error) =>
        console.error("Query history messages failed", error),
      );
    return () => this.disconnect();
  }

  private committedContext?: ChatContext;

  readonly afterCommit = () => {
    if (this.committedContext === this.chatContext) return;
    this.committedContext = this.chatContext;
    clearTimeout(this.scrollTimer);
    if (this.chatContext.status === "transmitting")
      this._throttledScrollToEnd();
    else this.scrollTimer = setTimeout(this._scrollToEnd, 500);
  };

  // These retained composer elements accept callbacks as properties rather
  // than DOM events. React treats an on-prefixed custom-element prop as an event.
  private readonly bindComposer = (element: AIChatComposer | null) => {
    if (element) element.onChatSuccess = this._onChatSuccess;
  };

  private readonly bindHistoryClear = (element: AIHistoryClear | null) => {
    if (element) element.onHistoryCleared = this._onHistoryCleared;
  };

  render(): ReactNode {
    const { host, _historyMessages } = this;
    if (!_historyMessages.length) {
      return null;
    }

    const latestHistoryMessage = _historyMessages[_historyMessages.length - 1];
    const latestMessageCreatedAt = latestHistoryMessage.createdAt;
    const { chatContext, updateContext } = this;

    const { messages: currentChatMessages } = chatContext;
    const notificationService = this.host.std.get(NotificationProvider);

    return createElement(
      ChatPeekConversation,
      {
        viewportRef: this._setMessagesViewport,
        header: createElement("ai-history-clear", {
          reactToLit: this.modalReactToLit,
          doc: this.host.store,
          session: this.forkSession,
          ref: this.bindHistoryClear,
          chatContextValue: chatContext,
          notificationService,
        }),
        composer: createElement("ai-chat-composer", {
          reactToLit: this.modalReactToLit,
          host,
          workspaceId: host.store.workspace.id,
          docId: host.store.id,
          session: this.forkSession ?? this.session,
          createSession: this.createForkSession,
          chatContextValue: chatContext,
          updateContext,
          docDisplayConfig: this.docDisplayConfig,
          searchMenuConfig: this.searchMenuConfig,
          myoxusWorkspaceDialogService: this.myoxusWorkspaceDialogService,
          notificationService,
          aiToolsConfigService: this.aiToolsConfigService,
          myoxusFeatureFlagService: this.myoxusFeatureFlagService,
          ref: this.bindComposer,
          trackOptions: peekTracking,
          portalContainer: this.parentElement,
          reasoningConfig: this.reasoningConfig,
          serverService: this.serverService,
          aiModelService: this.aiModelService,
        }),
      },
      createElement(StoredChatMessages, {
        host,
        messages: _historyMessages,
        readOnly: host.store.readonly,
        showGeneratedFiles: true,
        docDisplayConfig: this.docDisplayConfig,
        peekViewService: this.peekViewService,
      }),
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
      this.renderCurrentMessages(currentChatMessages),
    );
  }

  private _chatMessagesContainer: HTMLDivElement | null = null;
  private readonly _setMessagesViewport = (element: HTMLDivElement | null) => {
    this._chatMessagesContainer = element;
    if (element) this._scrollToEnd();
  };

  private _historyMessages: ChatMessage[] = [];
  private chatContext: ChatContext = {
    status: "idle",
    error: null,
    images: [],
    abortController: null,
    messages: [],
  };
  private session?: CopilotChatHistoryFragment | null;
  private forkSession?: CopilotChatHistoryFragment | null;
}
