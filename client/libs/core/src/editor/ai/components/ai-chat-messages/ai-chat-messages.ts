import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { createElement } from "react";
import { nanoid } from "nanoid";
import { ChatConversation } from "../message-chrome";
import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { AppThemeService } from "@myoxus/core/modules/theme";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import type { Signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import {
  DocModeProvider,
  type FeatureFlagService,
  type NotificationService,
} from "@virgultum/editor/shared/services";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { BaseSelection, ExtensionType } from "@virgultum/editor/store";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { debounce } from "lodash-es";

import { type AIError, AIProvider, UnauthorizedError } from "../../provider";
import { mergeStreamObjects } from "../../utils/stream-objects";
import { resolveRetryTarget } from "../../utils/chat-turn";
import type { DocDisplayConfig } from "../ai-chat-chips";
import { type ChatContextValue } from "../ai-chat-content/type";
import type { AIReasoningConfig } from "../ai-chat-input";
import {
  type HistoryMessage,
  type ChatMessage,
  isChatAction,
  isChatMessage,
  StreamObjectSchema,
} from "./type";

const EDITOR_PREVIEW_SCROLL_THRESHOLD_PX = 180;

export class AIChatMessages extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor aiModelService:
    AIModelService | undefined;
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;

  @property({ attribute: false })
  accessor onScrollAvailabilityChange:
    ((available: boolean) => void) | undefined;

  @state()
  accessor _selectionValue: BaseSelection[] = [];

  @state()
  accessor canScrollDown = false;

  @state()
  accessor avatarUrl = "";

  @state()
  accessor userName = "";

  @property({ attribute: false })
  accessor independentMode: boolean | undefined;

  @property({ attribute: false })
  accessor messages!: HistoryMessage[];

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor workspaceId!: string;

  @property({ attribute: false })
  accessor docId: string | undefined;

  @property({ attribute: false })
  accessor isHistoryLoading!: boolean;

  @property({ attribute: false })
  accessor chatContextValue!: ChatContextValue;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor createSession!: () => Promise<
    CopilotChatHistoryFragment | undefined
  >;

  @property({ attribute: false })
  accessor updateContext!: (context: Partial<ChatContextValue>) => void;

  @property({ attribute: false })
  accessor extensions!: ExtensionType[];

  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;

  @property({ attribute: false })
  accessor myoxusThemeService!: AppThemeService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor reasoningConfig!: AIReasoningConfig;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor docDisplayService!: DocDisplayConfig;

  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({
    type: String,
    attribute: "data-testid",
    reflect: true,
  })
  accessor testId = "chat-panel-messages";

  private get _isReasoningActive() {
    return !!this.reasoningConfig.enabled.value;
  }

  private readonly _onScroll = () => {
    const { clientHeight, scrollTop, scrollHeight } = this;
    const available =
      scrollHeight - scrollTop - clientHeight >
      EDITOR_PREVIEW_SCROLL_THRESHOLD_PX;
    if (this.canScrollDown !== available) {
      this.canScrollDown = available;
      this.onScrollAvailabilityChange?.(available);
    }
  };

  private readonly _debouncedOnScroll = debounce(
    this._onScroll.bind(this),
    100,
  );

  protected override render() {
    if (!this.reactToLit) return nothing;
    const { status, error } = this.chatContextValue;
    const { isHistoryLoading } = this;
    const filteredItems = this.messages;

    return this.reactToLit(
      createElement(
        ChatConversation,
        {
          loading: isHistoryLoading,
          empty: filteredItems.length === 0,
        },
        toReactNode(
          html`${repeat(
            filteredItems,
            (_, index) => index,
            (item, index) => {
              const isLast = index === filteredItems.length - 1;
              if (isChatMessage(item) && item.role === "user") {
                return html`<chat-message-user
                  .reactToLit=${this.reactToLit}
                  .item=${item}
                  .avatarUrl=${this.avatarUrl}
                  .userName=${this.userName}
                ></chat-message-user>`;
              } else if (isChatMessage(item) && item.role === "assistant") {
                return html`<chat-message-assistant
                  .reactToLit=${this.reactToLit}
                  .host=${this.host}
                  .session=${this.session}
                  .item=${item}
                  .isLast=${isLast}
                  .status=${isLast ? status : "idle"}
                  .error=${isLast ? error : null}
                  .extensions=${this.extensions}
                  .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
                  .myoxusThemeService=${this.myoxusThemeService}
                  .notificationService=${this.notificationService}
                  .retry=${() => this.retry()}
                  .width=${this.width}
                  .independentMode=${this.independentMode}
                  .docDisplayService=${this.docDisplayService}
                  .peekViewService=${this.peekViewService}
                  .onOpenDoc=${this.onOpenDoc}
                ></chat-message-assistant>`;
              } else if (isChatAction(item) && this.host) {
                return html`<chat-message-action
                  .reactToLit=${this.reactToLit}
                  .host=${this.host}
                  .item=${item}
                ></chat-message-action>`;
              }
              return nothing;
            },
          )}`,
        ),
      ),
      true,
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    const { disposables } = this;

    Promise.resolve(AIProvider.userInfo)
      .then((res) => {
        this.avatarUrl = res?.avatarUrl ?? "";
        this.userName = res?.name ?? "";
      })
      .catch(console.error);

    disposables.add(
      AIProvider.slots.userInfo.subscribe((userInfo) => {
        const { status, error } = this.chatContextValue;
        this.avatarUrl = userInfo?.avatarUrl ?? "";
        this.userName = userInfo?.name ?? "";
        if (
          status === "error" &&
          error instanceof UnauthorizedError &&
          userInfo
        ) {
          this.updateContext({ status: "idle", error: null });
        }
      }),
    );

    const selection$ = this.host?.selection.slots.changed;
    if (selection$) {
      disposables.add(
        selection$.subscribe(() => {
          this._selectionValue = this.host?.selection.value ?? [];
        }),
      );
    }

    const docModeService = this.host?.std.get(DocModeProvider);
    if (docModeService && this.docId) {
      disposables.add(
        docModeService.onPrimaryModeChange(
          () => this.requestUpdate(),
          this.docId,
        ),
      );
    }

    // Add scroll event listener to the host element
    this.addEventListener("scroll", this._debouncedOnScroll);
    disposables.add(() => {
      this.removeEventListener("scroll", this._debouncedOnScroll);
    });
  }

  protected override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has("isHistoryLoading")) {
      this.canScrollDown = false;
      this.onScrollAvailabilityChange?.(false);
    }

    if (
      _changedProperties.has("chatContextValue") &&
      this.chatContextValue.status === "transmitting"
    ) {
      this._onScroll();
    }
  }

  scrollToEnd() {
    requestAnimationFrame(() => {
      this.scrollTo({
        top: this.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  scrollToPos(top: number) {
    requestAnimationFrame(() => {
      this.scrollTo({ top });
    });
  }

  // Stop releases the UI before a non-abortable callback settles. The next
  // retry may acquire a new lease; old completions must never finalize it.
  private retryController: AbortController | null = null;

  override disconnectedCallback() {
    this.retryController?.abort();
    this.retryController = null;
    super.disconnectedCallback();
  }

  retry = async () => {
    if (
      (this.retryController && !this.retryController.signal.aborted) ||
      ["loading", "transmitting"].includes(this.chatContextValue.status) ||
      !AIProvider.actions.chat
    )
      return;
    const previous = this.chatContextValue.messages;
    if (
      !this.aiModelService?.supportsVision &&
      previous.some(
        (message) =>
          isChatMessage(message) &&
          message.role === "user" &&
          !!message.attachments?.length,
      )
    )
      return;
    const last = previous.at(-1);
    if (!last || !isChatMessage(last) || last.role !== "assistant") return;
    const abortController = new AbortController();
    const requestId = nanoid();
    const modelId = this.aiModelService?.effectiveModelId;
    const reasoning = this.aiModelService?.reasoningAvailable
      ? this._isReasoningActive
      : undefined;
    const toolsConfig = this.aiToolsConfigService.config.value;
    let sawOutput = false;
    this.retryController = abortController;
    const workspaceId = this.workspaceId;
    const docId = this.docId;
    const initialSessionId = this.session?.sessionId;
    let ownedSessionId = initialSessionId;
    const isCurrent = () =>
      this.isConnected &&
      !abortController.signal.aborted &&
      this.retryController === abortController &&
      this.workspaceId === workspaceId &&
      this.docId === docId &&
      (this.session?.sessionId === initialSessionId ||
        this.session?.sessionId === ownedSessionId) &&
      (!this.chatContextValue.abortController ||
        this.chatContextValue.abortController === abortController);
    this.updateContext({
      status: "loading",
      error: null,
      abortController,
      retrievalAvailable: undefined,
    });
    try {
      const sessionId = (await this.createSession())?.sessionId;
      ownedSessionId = sessionId;
      if (!isCurrent() || abortController.signal.aborted) return;
      if (!sessionId) throw new Error("Conversation creation unavailable");
      if (!AIProvider.histories)
        throw new Error("The original user turn is unavailable");
      const history = await AIProvider.histories.chats(workspaceId, sessionId);
      if (!isCurrent()) return;
      const stored = (history?.[0]?.messages ?? []) as ChatMessage[];
      const { user, response, expectedStreamId } = resolveRetryTarget(
        previous,
        stored,
      );
      const messages = [
        ...previous.slice(0, -1),
        {
          ...last,
          content: "",
          streamObjects: [],
          createdAt: new Date().toISOString(),
          id: response?.id ?? "",
          params: { requestId },
        },
      ];
      this.updateContext({
        messages,
      });

      const stream = await AIProvider.actions.chat({
        sessionId,
        retry: true,
        requestId,
        messageId: user.id,
        responseId: response?.id,
        expectedStreamId,
        docId,
        workspaceId,
        stream: true,
        signal: abortController.signal,
        where: "chat-panel",
        control: "chat-send",
        isRootSession: true,
        modelId,
        reasoning,
        toolsConfig,
        onRetrievalStatus: (available) => {
          if (isCurrent())
            this.updateContext({ retrievalAvailable: available });
        },
      });

      let requestMessages = messages;
      for await (const text of stream) {
        if (!isCurrent() || abortController.signal.aborted) break;
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

      if (isCurrent() && !abortController.signal.aborted) {
        const finalHistory = await AIProvider.histories.chats(
          workspaceId,
          sessionId,
        );
        if (!isCurrent()) return;
        const final = (finalHistory?.[0]?.messages ?? []) as ChatMessage[];
        const current = final.find(
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
      }
    } catch (error) {
      if (isCurrent())
        this.updateContext(
          abortController.signal.aborted
            ? { status: "idle" }
            : {
                status: "error",
                error: error as AIError,
                ...(!sawOutput ? { messages: previous } : {}),
              },
        );
    } finally {
      if (
        isCurrent() &&
        this.chatContextValue.abortController === abortController
      )
        this.updateContext({
          abortController: null,
          ...(abortController.signal.aborted ? { status: "idle" } : {}),
        });
      if (this.retryController === abortController) this.retryController = null;
    }
  };
}
