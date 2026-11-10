import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIDraftState } from "@myoxus/core/modules/ai-button/services/ai-draft";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { ServerService } from "@myoxus/core/modules/server";
import type { AppThemeService } from "@myoxus/core/modules/theme";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { type Signal } from "@preact/signals-core";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/shared/services";
import {
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { pick } from "lodash-es";

import { type AIChatParams, AIProvider } from "../../provider/ai-provider";
import { extractSelectedContent } from "../../utils/extract";
import { HISTORY_IMAGE_ACTIONS } from "../../utils/history-image-actions";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { AIReasoningConfig } from "../ai-chat-input";
import {
  type AIChatMessages,
  type ChatAction,
  type ChatMessage,
  type HistoryMessage,
  isChatMessage,
} from "../ai-chat-messages";
import type { ChatContextValue } from "./type";
import { chatI18n } from "../chat-i18n";

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

export class AIChatContent extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  static override styles = css`
    ai-chat-content {
      display: flex;
      flex-direction: column;
    }
    /* The Workbench's native flex card supplies the bound. Preserve it through
       retained Lit hosts so only messages scroll and the composer stays visible. */
    ai-chat-content[bounded-mode],
    ai-chat-content[bounded-mode] chat-panel-split-view,
    ai-chat-content[bounded-mode] .ai-chat-panel-split-view-left,
    ai-chat-content[bounded-mode] .chat-panel-main {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }
    ai-chat-content[bounded-mode] ai-chat-messages {
      /* Bound the retained renderer independently of its transcript. Keep a
         small reading viewport when other tools overflow the shared rail. */
      contain: size;
      flex: 1 1 auto;
      min-height: 8lh;
      overflow-y: auto;
      overscroll-behavior-y: contain;
    }
    ai-chat-content[bounded-mode] .ai-chat-panel-split-view {
      flex: 1 1 auto;
      min-height: 0;
    }
    ai-chat-content[bounded-mode] ai-chat-composer {
      flex-shrink: 0;
    }
    ai-chat-content[independent-mode] {
      justify-content: center;
      height: 100%;

      ai-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 0 var(--h-padding);
        transition:
          flex-grow 0.32s cubic-bezier(0.07, 0.83, 0.46, 1),
          padding-top 0.32s ease,
          padding-bottom 0.32s ease;
      }
      ai-chat-messages.independent-mode.no-message {
        flex-grow: 0;
        flex-shrink: 0;
        overflow-y: visible;
      }
    }
    chat-panel-split-view {
      width: 100%;
      container-type: inline-size;
      container-name: chat-panel-split-view;
    }
    .chat-panel-main {
      display: flex;
      flex-direction: column;
      width: 100%;
    }
    ai-chat-content[independent-mode] chat-panel-split-view {
      height: 100%;
    }
    .chat-panel-main[data-independent="true"] {
      --h-padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      justify-content: center;
      height: 100%;
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")}
        ${unsafeCSSValue(
          "clamp(\n    var(--mantine-spacing-xs),\n    2cqi,\n    var(--mantine-spacing-lg)\n  )",
        )}
        0;
      max-width: ${unsafeCSSValue(
        "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 20\n  )",
      )};
      margin: 0 auto;
    }

    ai-chat-content[independent-mode] ai-chat-composer {
      padding: 0 var(--h-padding);
    }
  `;

  /**
   * Standalone chat fills its route. Sidebar sizing is supplied separately by
   * the bounded Workbench tool body and must not enable standalone centering.
   */
  @property({ type: Boolean, attribute: "independent-mode", reflect: true })
  accessor independentMode: boolean | undefined;

  @property({ type: Boolean, attribute: "bounded-mode", reflect: true })
  accessor boundedMode: boolean = false;

  @property({ attribute: false })
  accessor host: EditorHost | null | undefined;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor createSession!: () => Promise<
    CopilotChatHistoryFragment | undefined
  >;

  @property({ attribute: false })
  accessor workspaceId!: string;

  @property({ attribute: false })
  accessor docId: string | undefined;

  @property({ attribute: false })
  accessor reasoningConfig!: AIReasoningConfig;

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
  accessor myoxusWorkspaceDialogService!: WorkspaceDialogService;

  @property({ attribute: false })
  accessor myoxusThemeService!: AppThemeService;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor aiDraftService: AIDraftService | undefined;

  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor aiModelService!: AIModelService;

  @property({ attribute: false })
  accessor onEmbeddingProgressChange:
    ((count: Record<ContextEmbedStatus, number>) => void) | undefined;

  @property({ attribute: false })
  accessor onContextChange!: (context: Partial<ChatContextValue>) => void;

  @property({ attribute: false })
  accessor onOpenDoc!: (docId: string, sessionId?: string) => void;

  @property({ attribute: false })
  accessor width: Signal<number | undefined> | undefined;

  @property({ attribute: false })
  accessor peekViewService!: PeekViewService;

  @state()
  accessor chatContextValue: ChatContextValue = DEFAULT_CHAT_CONTEXT_VALUE;

  @state()
  accessor isHistoryLoading = false;

  @state()
  private accessor historyLoadFailed = false;

  @state()
  private accessor showPreviewPanel = false;

  @state()
  private accessor previewPanelContent: TemplateResult<1> | null = null;

  private readonly chatMessagesRef: Ref<AIChatMessages> =
    createRef<AIChatMessages>();

  // request counter to track the latest request
  private updateHistoryCounter = 0;
  private historyIdentity: string | undefined;
  private draftRestoreRevision = 0;

  private get currentHistoryIdentity() {
    return JSON.stringify([
      this.workspaceId,
      this.docId,
      this.session?.sessionId,
    ]);
  }

  private lastScrollTop: number | undefined;

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

  private readonly loadHistory = async () => {
    if (!AIProvider.histories) {
      return undefined;
    }

    const sessionId = this.session?.sessionId;
    const [histories, actions] = await Promise.all([
      sessionId
        ? AIProvider.histories.chats(this.workspaceId, sessionId)
        : Promise.resolve([]),
      this.docId && this.showActions
        ? AIProvider.histories.actions(this.workspaceId, this.docId)
        : Promise.resolve([]),
    ]);

    const messages: HistoryMessage[] = [];
    const chatActions = (actions || []) as ChatAction[];
    messages.push(...chatActions);

    const chatMessages = (histories?.[0]?.messages || []) as ChatMessage[];
    messages.push(...chatMessages);

    return messages.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  };

  private readonly updateActions = async () => {
    if (!this.docId || !AIProvider.histories || !this.showActions) {
      return;
    }
    const identity = this.currentHistoryIdentity;
    const request = this.updateHistoryCounter;
    const actions = await AIProvider.histories.actions(
      this.workspaceId,
      this.docId,
    );
    if (
      this.isConnected &&
      identity === this.currentHistoryIdentity &&
      request === this.updateHistoryCounter &&
      actions?.length
    ) {
      const chatMessages = this.chatContextValue.messages.filter((message) =>
        isChatMessage(message),
      );
      const chatActions = actions as ChatAction[];
      const messages: HistoryMessage[] = [...chatMessages, ...chatActions];
      this.updateContext({
        messages: messages.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
      });
    }
  };

  private readonly updateContext = (context: Partial<ChatContextValue>) => {
    if (["quote", "images", "markdown"].some((key) => key in context))
      this.draftRestoreRevision++;
    if (
      (context.status === "loading" || context.status === "transmitting") &&
      this.chatContextValue.status !== "loading" &&
      this.chatContextValue.status !== "transmitting"
    ) {
      this.updateHistoryCounter++;
      this.isHistoryLoading = false;
    }
    this.chatContextValue = { ...this.chatContextValue, ...context };
    this.onContextChange?.(context);
    this.updateDraft(context).catch(console.error);
  };

  private readonly updateDraft = async (context: Partial<ChatContextValue>) => {
    if (!this.aiDraftService) {
      return;
    }
    const draft: Partial<AIDraftState> = pick(context, [
      "quote",
      "images",
      "markdown",
    ]);
    if (!Object.keys(draft).length) {
      return;
    }
    await this.aiDraftService.setDraft(draft);
  };

  private readonly initChatContent = async () => {
    const request = ++this.updateHistoryCounter;
    const identity = this.currentHistoryIdentity;
    const isCurrent = () =>
      this.isConnected &&
      request === this.updateHistoryCounter &&
      identity === this.currentHistoryIdentity;
    this.isHistoryLoading = true;
    this.historyLoadFailed = false;
    try {
      const messages = await this.loadHistory();
      if (isCurrent() && messages) this.updateContext({ messages });
    } catch {
      if (isCurrent()) this.historyLoadFailed = true;
    } finally {
      if (isCurrent()) this.isHistoryLoading = false;
    }
  };

  protected override firstUpdated(): void {}

  protected override willUpdate() {
    const identity = this.currentHistoryIdentity;
    if (identity === this.historyIdentity) return;
    const previous = this.historyIdentity
      ? (JSON.parse(this.historyIdentity) as [
          string | null,
          string | null,
          string | null,
        ])
      : undefined;
    if (
      previous &&
      (previous[0] !== this.workspaceId ||
        previous[1] !== (this.docId ?? null) ||
        (previous[2] !== null &&
          previous[2] !== (this.session?.sessionId ?? null)))
    ) {
      this.chatContextValue.abortController?.abort();
      this.updateContext({
        abortController: null,
        status: "idle",
        retrievalAvailable: undefined,
      });
    }
    this.historyIdentity = identity;
    // Assigning the newly created session during send is not a history switch:
    // the active request already owns its user turn and pending assistant.
    if (
      this.chatContextValue.status === "loading" ||
      this.chatContextValue.status === "transmitting"
    ) {
      this.updateHistoryCounter += 1;
      this.isHistoryLoading = false;
      return;
    }
    if (
      this.session?.messages?.length &&
      !this.chatContextValue.messages.length
    ) {
      this.chatContextValue = {
        ...this.chatContextValue,
        messages: this.session.messages as ChatMessage[],
      };
    }
    void this.initChatContent();
  }

  private _scrollListenersInitialized = false;
  private _initializeScrollListeners() {
    const chatMessages = this.chatMessagesRef.value;
    if (chatMessages) {
      chatMessages.updateComplete
        .then(() => {
          chatMessages.addEventListener("scrollend", () => {
            this.lastScrollTop = chatMessages.scrollTop;
          });
          this._scrollListenersInitialized = true;
        })
        .catch(console.error);
    }
  }

  protected override updated(changedProperties: PropertyValues) {
    // restore pinned chat scroll position
    if (
      changedProperties.has("host") &&
      this.session?.pinned &&
      this.lastScrollTop !== undefined
    ) {
      this.chatMessagesRef.value?.scrollToPos(this.lastScrollTop);
    }

    if (!this._scrollListenersInitialized) {
      this._initializeScrollListeners();
    }
  }

  public openPreviewPanel(content?: TemplateResult<1>) {
    this.showPreviewPanel = true;
    if (content) this.previewPanelContent = content;
    AIProvider.slots.previewPanelOpenChange.next(true);
  }

  public closePreviewPanel(destroyContent: boolean = false) {
    this.showPreviewPanel = false;
    if (destroyContent) this.previewPanelContent = null;
    AIProvider.slots.previewPanelOpenChange.next(false);
  }

  public get isPreviewPanelOpen() {
    return this.showPreviewPanel;
  }

  override connectedCallback() {
    super.connectedCallback();

    this.historyIdentity = undefined;
    this.requestUpdate();
    this._disposables.add(
      AIProvider.slots.sessionReady.subscribe((ready) => {
        if (
          ready &&
          this.historyIdentity &&
          this.chatContextValue.status !== "loading" &&
          this.chatContextValue.status !== "transmitting"
        )
          void this.initChatContent();
      }),
    );

    if (this.aiDraftService) {
      const revision = this.draftRestoreRevision;
      this.aiDraftService
        .getDraft()
        .then((draft) => {
          if (!this.isConnected || revision !== this.draftRestoreRevision)
            return;
          this.chatContextValue = {
            ...this.chatContextValue,
            quote: draft.quote,
            markdown: draft.markdown,
            images: draft.images,
          };
        })
        .catch(console.error);
    }

    this._disposables.add(
      AIProvider.slots.actions.subscribe(({ event }) => {
        const { status } = this.chatContextValue;
        if (
          event === "finished" &&
          (status === "idle" || status === "success")
        ) {
          this.updateActions().catch(console.error);
        }
      }),
    );

    this._disposables.add(
      AIProvider.slots.requestOpenWithChat.subscribe(
        (params: AIChatParams | null) => {
          if (!params) {
            return;
          }
          if (this.host === params.host) {
            if (params.fromAnswer && params.context) {
              this.updateContext(params.context);
            } else {
              extractSelectedContent(params.host)
                .then((context) => {
                  if (!context) return;
                  this.updateContext(context);
                })
                .catch(console.error);
            }
          }
          AIProvider.slots.requestOpenWithChat.next(null);
        },
      ),
    );
  }

  override disconnectedCallback() {
    this.draftRestoreRevision++;
    this.updateHistoryCounter += 1;
    this.chatContextValue.abortController?.abort();
    super.disconnectedCallback();
  }

  override render() {
    const historyError = this.historyLoadFailed
      ? html`<ai-error-wrapper
          .reactToLit=${this.reactToLit}
          .text=${chatI18n()["com.myoxus.ai.chat-panel.history-error"]()}
          .actionText=${chatI18n()["Retry"]()}
          .onClick=${() => void this.initChatContent()}
        ></ai-error-wrapper>`
      : nothing;
    const left = html` <ai-chat-messages
        .aiModelService=${this.aiModelService}
        .onScrollAvailabilityChange=${this.onScrollAvailabilityChange}
        .reactToLit=${this.reactToLit}
        class=${classMap({
          "ai-chat-messages": true,
          "independent-mode": !!this.independentMode,
          "no-message": this.messages.length === 0,
        })}
        ${ref(this.chatMessagesRef)}
        .host=${this.host}
        .workspaceId=${this.workspaceId}
        .docId=${this.docId}
        .session=${this.session}
        .createSession=${this.createSession}
        .chatContextValue=${this.chatContextValue}
        .updateContext=${this.updateContext}
        .isHistoryLoading=${this.isHistoryLoading}
        .extensions=${this.extensions}
        .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
        .myoxusThemeService=${this.myoxusThemeService}
        .notificationService=${this.notificationService}
        .aiToolsConfigService=${this.aiToolsConfigService}
        .reasoningConfig=${this.reasoningConfig}
        .width=${this.width}
        .independentMode=${this.independentMode}
        .messages=${this.messages}
        .docDisplayService=${this.docDisplayConfig}
        .peekViewService=${this.peekViewService}
        .onOpenDoc=${this.onOpenDoc}
      ></ai-chat-messages>
      <ai-chat-composer
        .onScrollToLatest=${this.canScrollToLatest ? this.scrollToLatest : undefined}
        .reactToLit=${this.reactToLit}
        .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
        .independentMode=${this.independentMode}
        .host=${this.host}
        .workspaceId=${this.workspaceId}
        .docId=${this.docId}
        .session=${this.session}
        .createSession=${this.createSession}
        .chatContextValue=${this.chatContextValue}
        .updateContext=${this.updateContext}
        .onEmbeddingProgressChange=${this.onEmbeddingProgressChange}
        .reasoningConfig=${this.reasoningConfig}
        .docDisplayConfig=${this.docDisplayConfig}
        .searchMenuConfig=${this.searchMenuConfig}
        .serverService=${this.serverService}
        .myoxusWorkspaceDialogService=${this.myoxusWorkspaceDialogService}
        .notificationService=${this.notificationService}
        .aiDraftService=${this.aiDraftService}
        .aiToolsConfigService=${this.aiToolsConfigService}
        .aiModelService=${this.aiModelService}
        .trackOptions=${{
          where: "chat-panel",
          control: "chat-send",
        }}
      ></ai-chat-composer>`;

    const right = this.previewPanelContent;

    return html`<chat-panel-split-view
      .left=${html`<div
        class="chat-panel-main"
        data-empty=${this.messages.length === 0}
        data-independent=${!!this.independentMode}
      >
        ${historyError} ${left}
      </div>`}
      .right=${right}
      .open=${this.showPreviewPanel}
    >
    </chat-panel-split-view>`;
  }

  @state()
  private accessor canScrollToLatest = false;

  // The jump action lives outside the message scroller so toggling it cannot
  // move the content target during native smooth scrolling.
  private readonly onScrollAvailabilityChange = (available: boolean) => {
    this.canScrollToLatest = available;
  };
  private readonly scrollToLatest = () => {
    this.chatMessagesRef.value?.scrollToEnd();
  };
}
