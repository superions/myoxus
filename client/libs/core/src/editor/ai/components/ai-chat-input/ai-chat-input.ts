// SPDX-License-Identifier: MIT
import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { ServerService } from "@myoxus/core/modules/server";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { NotificationService } from "@virgultum/shared/services";
import { html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { createElement } from "react";
import { nanoid } from "nanoid";

import { type AIError, AIProvider, type AISendParams } from "../../provider";
import { readBlobAsURL } from "../../utils/image";
import { mergeStreamObjects } from "../../utils/stream-objects";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { ChatChip, DocDisplayConfig } from "../ai-chat-chips/type";
import {
  isDocChip,
  isFileChip,
  isAttachmentChip,
} from "../ai-chat-chips/utils";
import {
  type ChatMessage,
  isChatMessage,
  StreamObjectSchema,
} from "../ai-chat-messages";
import type { AIChatInputContext, AIReasoningConfig } from "./type";
import { ChatInputView } from "./view";

/** Retains draft/request ownership while React supplies native input chrome. */
export class AIChatInput extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor independentMode: boolean | undefined;
  @property({ attribute: false }) accessor host: EditorHost | null | undefined;
  @property({ attribute: false }) accessor workspaceId!: string;
  @property({ attribute: false }) accessor docId: string | undefined;
  @property({ attribute: false }) accessor session!:
    CopilotChatHistoryFragment | null | undefined;
  @property({ attribute: false }) accessor isContextProcessing:
    boolean | undefined;
  @query("textarea") accessor textarea!: HTMLTextAreaElement;
  @property({ attribute: false })
  accessor chatContextValue!: AIChatInputContext;
  @property({ attribute: false }) accessor chips: ChatChip[] = [];
  @property({ attribute: false }) accessor createSession!: () => Promise<
    CopilotChatHistoryFragment | undefined
  >;
  @property({ attribute: false }) accessor updateContext!: (
    context: Partial<AIChatInputContext>,
  ) => void;
  @property({ attribute: false }) accessor addImages!: (images: File[]) => void;
  @property({ attribute: false }) accessor addChip!: (
    chip: ChatChip,
    silent?: boolean,
  ) => Promise<void>;
  @property({ attribute: false }) accessor reasoningConfig!: AIReasoningConfig;
  @property({ attribute: false }) accessor docDisplayConfig!: DocDisplayConfig;
  @property({ attribute: false }) accessor searchMenuConfig!: SearchMenuConfig;
  @property({ attribute: false }) accessor serverService!: ServerService;
  @property({ attribute: false }) accessor aiDraftService:
    AIDraftService | undefined;
  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;
  @property({ attribute: false })
  accessor myoxusFeatureFlagService!: FeatureFlagService;
  @property({ attribute: false })
  accessor notificationService!: NotificationService;
  @property({ attribute: false }) accessor aiModelService!: AIModelService;
  @property({ attribute: false }) accessor isRootSession = true;
  @property({ attribute: false }) accessor onChatSuccess:
    (() => void) | undefined;
  @property({ attribute: false }) accessor trackOptions:
    VirgultumPresets.TrackerOptions | undefined;
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "chat-panel-input-container";
  @property({ attribute: false }) accessor portalContainer: HTMLElement | null =
    null;

  // One transient draft source for both Lit orchestration and the native view.
  readonly draft = signal("");
  private draftRevision = 0;
  // The parent Lit props can lag the first synchronous send/stop transition.
  // This is the request lease, not another conversation or draft store.
  @state() private accessor activeRequest: AbortController | null = null;
  private isActiveRequestCurrent: (() => boolean) | undefined;

  private get isBusy() {
    return (
      !!this.activeRequest ||
      this.chatContextValue.status === "loading" ||
      this.chatContextValue.status === "transmitting"
    );
  }

  private get _isReasoningActive() {
    return !!this.reasoningConfig.enabled.value;
  }

  private get imageInputUnsupported() {
    const hasImages =
      this.chatContextValue.images.length > 0 ||
      this.chatContextValue.messages.some(
        (message) =>
          isChatMessage(message) &&
          message.role === "user" &&
          !!message.attachments?.length,
      );
    return hasImages && !this.aiModelService.supportsVision;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._disposables.add(
      AIProvider.slots.requestSendWithChat.subscribe(
        (params: AISendParams | null) => {
          if (!params) return;
          const { input, context, host } = params;
          if (this.host === host && !this.isBusy && !this.isContextProcessing) {
            const workspaceId = this.workspaceId;
            const docId = this.docId;
            const sessionId = this.session?.sessionId;
            if (context) this.updateContext(context);
            setTimeout(() => {
              if (
                !this.isConnected ||
                this.host !== host ||
                this.workspaceId !== workspaceId ||
                this.docId !== docId ||
                this.session?.sessionId !== sessionId
              )
                return;
              this.send(input).catch(console.error);
            }, 0);
          }
          AIProvider.slots.requestSendWithChat.next(null);
        },
      ),
    );
    this._disposables.add(
      AIProvider.slots.requestOpenWithChat.subscribe((params) => {
        if (!params || this.host !== params.host) return;
        if (params.input) {
          this.draftRevision++;
          this.draft.value = params.input;
        }
      }),
    );
  }

  protected override firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);
    const revision = this.draftRevision;
    this.aiDraftService
      ?.getDraft()
      .then((draft) => {
        // A slow restore must not replace text entered or supplied after mount.
        if (this.isConnected && revision === this.draftRevision)
          this.draft.value = draft.input;
      })
      .catch(console.error);
  }

  protected override willUpdate(changes: PropertyValues) {
    if (
      this.activeRequest &&
      (changes.has("workspaceId") ||
        changes.has("docId") ||
        changes.has("session")) &&
      !this.isActiveRequestCurrent?.()
    )
      this.stopRequest(this.activeRequest);
  }

  override disconnectedCallback() {
    this.draftRevision++;
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.isActiveRequestCurrent = undefined;
    super.disconnectedCallback();
  }

  protected override render() {
    if (!this.reactToLit) return nothing;
    const { images, status } = this.chatContextValue;
    const generating =
      !!this.activeRequest || status === "loading" || status === "transmitting";
    return this.reactToLit(
      createElement(ChatInputView, {
        draft: this.draft,
        quote: this.chatContextValue.quote,
        images: images.length
          ? toReactNode(
              html`<image-preview-grid
                .reactToLit=${this.reactToLit}
                .images=${images}
                .onImageRemove=${this._handleImageRemove}
              ></image-preview-grid>`,
            )
          : null,
        context: toReactNode(
          html`<ai-chat-add-context
            .reactToLit=${this.reactToLit}
            .disabled=${generating}
            .docId=${this.docId}
            .independentMode=${this.independentMode}
            .addChip=${this.addChip}
            .addImages=${this.addImages}
            .docDisplayConfig=${this.docDisplayConfig}
            .searchMenuConfig=${this.searchMenuConfig}
            .portalContainer=${this.portalContainer}
          ></ai-chat-add-context>`,
        ),
        preferences: toReactNode(
          html`<chat-input-preference
            .reactToLit=${this.reactToLit}
            .session=${this.session}
            .extendedThinking=${this._isReasoningActive}
            .disabled=${generating}
            .onExtendedThinkingChange=${this._toggleReasoning}
            .toolsConfigService=${this.aiToolsConfigService}
            .aiModelService=${this.aiModelService}
          ></chat-input-preference>`,
        ),
        generating,
        imageInputUnsupported: this.imageInputUnsupported,
        retrievalUnavailable:
          this.chatContextValue.retrievalAvailable === false &&
          this.aiToolsConfigService?.config.value.searchWorkspace !== false,
        sendDisabled: this.isSendDisabled,
        onInput: (value) => {
          this._handleInput(value).catch(console.error);
        },
        onSend: (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._onTextareaSend().catch(console.error);
        },
        onStop: this._handleAbort,
        onPaste: (event) => this._handlePaste(event.nativeEvent),
        onRemoveQuote: () => this.updateContext({ quote: "", markdown: "" }),
      }),
      true,
    );
  }

  private get isSendDisabled() {
    return (
      this.isBusy ||
      !this.draft.value.trim() ||
      !!this.isContextProcessing ||
      this.imageInputUnsupported
    );
  }

  private readonly _handleInput = async (value: string) => {
    if (value === this.draft.value) return;
    this.draftRevision++;
    this.draft.value = value;
    await this.aiDraftService?.setDraft({ input: value });
  };

  private readonly _handlePaste = (event: ClipboardEvent) => {
    event.stopPropagation();
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) this.addImages([blob]);
      }
    }
  };

  private stopRequest(controller: AbortController) {
    const ownsRequest = this.activeRequest === controller;
    controller.abort();
    if (ownsRequest) {
      this.activeRequest = null;
      this.isActiveRequestCurrent = undefined;
    }
    // Stop must release this input even before the provider's first token. The
    // send loop's identity checks discard any later result from this request.
    if (ownsRequest || this.chatContextValue.abortController === controller) {
      this.updateContext({ abortController: null, status: "idle" });
    }
  }

  private readonly _handleAbort = () => {
    const controller =
      this.activeRequest ?? this.chatContextValue.abortController;
    if (!controller) return;
    this.stopRequest(controller);
  };

  private readonly _toggleReasoning = (enabled: boolean) => {
    this.reasoningConfig.setEnabled(enabled);
  };

  private readonly _handleImageRemove = (index: number) => {
    this.updateContext({
      images: this.chatContextValue.images.filter((_, i) => i !== index),
    });
  };

  private readonly _onTextareaSend = async () => {
    const value = this.draft.value.trim();
    // Rejected sends preserve the draft even while Enter remains available.
    if (this.isSendDisabled || !value) return;
    await this.send(value, true);
  };

  send = async (text: string, clearDraft = false) => {
    if (
      !this.isConnected ||
      this.isBusy ||
      this.isContextProcessing ||
      this.imageInputUnsupported ||
      !text.trim() ||
      !AIProvider.actions.chat
    )
      return;
    const before = this.chatContextValue;
    const originalDraft = this.draft.value;
    const submittedDraftRevision = this.draftRevision;
    const originalSessionId = this.session?.sessionId;
    let ownedSessionId = originalSessionId;
    const workspaceId = this.workspaceId;
    const docId = this.docId;
    const abortController = new AbortController();
    const requestId = nanoid();
    const modelId = this.aiModelService.effectiveModelId;
    const reasoning = this.aiModelService.reasoningAvailable
      ? this._isReasoningActive
      : undefined;
    const toolsConfig = this.aiToolsConfigService.config.value;
    this.activeRequest = abortController;
    const isCurrent = () =>
      this.isConnected &&
      this.activeRequest === abortController &&
      this.workspaceId === workspaceId &&
      this.docId === docId &&
      (this.session?.sessionId === originalSessionId ||
        this.session?.sessionId === ownedSessionId);
    // A Peek may resolve its own fork from a nonempty source session. Scope
    // validation must recognize that returned identity, not abort every change.
    this.isActiveRequestCurrent = isCurrent;
    let clearedRevision: number | undefined;
    try {
      const { markdown, images, snapshot, combinedElementsMarkdown, html } =
        before;
      this.updateContext({
        status: "loading",
        retrievalAvailable: undefined,
        error: null,
        abortController,
      });

      const imageAttachments = await Promise.all(
        images?.map((image) => readBlobAsURL(image)),
      );
      if (!isCurrent() || abortController.signal.aborted) return;
      const userInput = text;

      const sessionId = (await this.createSession())?.sessionId;
      ownedSessionId = sessionId;
      if (!isCurrent() || abortController.signal.aborted) return;
      if (!sessionId) throw new Error("Conversation creation unavailable");
      const contexts = await this._getMatchedContexts();
      if (!isCurrent() || abortController.signal.aborted) return;

      let requestMessages = before.messages;
      const stream = await AIProvider.actions.chat({
        sessionId,
        requestId,
        input: userInput,
        contexts: {
          ...contexts,
          // Selection is explicit quoted context, never a replacement for the
          // user's question or dependent on optional full-object feature flags.
          selectedSnapshot: snapshot || undefined,
          selectedMarkdown: combinedElementsMarkdown || markdown || undefined,
          html: html || undefined,
        },
        docId,
        attachments: images,
        workspaceId,
        stream: true,
        signal: abortController.signal,
        isRootSession: this.isRootSession,
        where: this.trackOptions?.where,
        control: this.trackOptions?.control,
        reasoning,
        toolsConfig,
        modelId,
        onMessageCreated: async () => {
          if (!isCurrent() || abortController.signal.aborted) return;
          const acknowledged = await this._preUpdateMessages(
            userInput,
            imageAttachments,
            before.messages,
            isCurrent,
            requestId,
          );
          if (!acknowledged || !isCurrent() || abortController.signal.aborted)
            return;
          requestMessages = acknowledged;
          // Upload/message acknowledgement, not Send, consumes this draft.
          // Preserve any text/images added while noncancelable upload was pending.
          this.updateContext({
            images: this.chatContextValue.images.filter(
              (image) => !images.includes(image),
            ),
            quote:
              this.chatContextValue.quote === before.quote
                ? ""
                : this.chatContextValue.quote,
            markdown:
              this.chatContextValue.markdown === before.markdown
                ? ""
                : this.chatContextValue.markdown,
          });
          if (clearDraft && this.draftRevision === submittedDraftRevision) {
            clearedRevision = ++this.draftRevision;
            this.draft.value = "";
            await this.aiDraftService?.setDraft({ input: "" });
          }
        },
        onRetrievalStatus: (available) => {
          if (isCurrent() && !abortController.signal.aborted)
            this.updateContext({ retrievalAvailable: available });
        },
      });

      // Parent-to-input Lit props may lag a burst of stream events. Accumulate
      // from this request's last emitted snapshot, not a stale rendered prop.
      for await (const text of stream) {
        if (abortController.signal.aborted || !isCurrent()) break;
        const messages = requestMessages.slice(0);
        const last = messages.at(-1);
        if (last && isChatMessage(last)) {
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

      if (abortController.signal.aborted || !isCurrent()) return;
      // update message id from server
      await this._postUpdateMessages(
        sessionId,
        requestMessages,
        isCurrent,
        requestId,
      );
      if (isCurrent() && !abortController.signal.aborted) {
        this.onChatSuccess?.();
        this.updateContext({ status: "success" });
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (abortController.signal.aborted) {
        this.updateContext({ status: "idle" });
        return;
      }
      if (
        clearedRevision !== undefined &&
        clearedRevision === this.draftRevision
      ) {
        this.draftRevision++;
        this.draft.value = originalDraft;
        void this.aiDraftService
          ?.setDraft({ input: originalDraft })
          .catch(console.error);
      }
      this.updateContext({
        status: "error",
        error: error as AIError,
        images: [
          ...new Set([...before.images, ...this.chatContextValue.images]),
        ],
        quote: this.chatContextValue.quote || before.quote,
        markdown: this.chatContextValue.markdown || before.markdown,
      });
    } finally {
      // Rejected or superseded sends must not clear another request's controller.
      if (
        isCurrent() &&
        this.chatContextValue.abortController === abortController
      ) {
        this.updateContext({
          abortController: null,
          ...(abortController.signal.aborted ? { status: "idle" } : {}),
        });
      }
      if (this.activeRequest === abortController) {
        this.activeRequest = null;
        this.isActiveRequestCurrent = undefined;
      }
    }
  };

  private readonly _preUpdateMessages = async (
    userInput: string,
    attachments: string[],
    previous: AIChatInputContext["messages"],
    isCurrent: () => boolean,
    requestId: string,
  ) => {
    const userInfo = await AIProvider.userInfo;
    if (!isCurrent()) return undefined;
    const messages: AIChatInputContext["messages"] = [
      ...previous,
      {
        id: "",
        role: "user",
        content: userInput,
        params: { inputRequestId: requestId },
        createdAt: new Date().toISOString(),
        attachments,
        userId: userInfo?.id,
        userName: userInfo?.name,
        avatarUrl: userInfo?.avatarUrl ?? undefined,
      },
      {
        id: "",
        role: "assistant",
        content: "",
        params: { requestId },
        createdAt: new Date().toISOString(),
      },
    ];
    this.updateContext({ messages });
    return messages;
  };

  private readonly _postUpdateMessages = async (
    sessionId: string,
    messages: AIChatInputContext["messages"],
    isCurrent: () => boolean,
    requestId: string,
  ) => {
    if (!sessionId || !AIProvider.histories) return;

    const histories = await AIProvider.histories.chats(
      this.workspaceId,
      sessionId,
    );
    if (!isCurrent()) return;
    const stored = (histories?.[0]?.messages ?? []) as ChatMessage[];
    const user = stored.find(
      (message) =>
        message.role === "user" && message.params?.inputRequestId === requestId,
    );
    const assistant = stored.find(
      (message) =>
        message.role === "assistant" && message.params?.responseTo === user?.id,
    );
    if (!user || !assistant)
      throw new Error("The response identity could not be reconciled");
    const localUser = messages.at(-2) as ChatMessage,
      last = messages.at(-1) as ChatMessage;
    this.updateContext({
      messages: [
        ...messages.slice(0, -2),
        { ...localUser, id: user.id, params: user.params },
        { ...last, id: assistant.id, params: assistant.params },
      ],
    });
  };

  private async _getMatchedContexts() {
    const docContexts = new Map<
      string,
      { docId: string; docContent: string }
    >();

    this.chips.forEach((chip) => {
      if (isDocChip(chip)) {
        docContexts.set(chip.docId, {
          docId: chip.docId,
          docContent: chip.markdown?.value ?? "",
        });
      }
    });

    const docs: VirgultumPresets.AIDocContextOption[] = Array.from(
      docContexts.values(),
    ).map((doc) => {
      const docMeta = this.docDisplayConfig.getDocMeta(doc.docId);
      const docTitle = this.docDisplayConfig.getTitle(doc.docId);
      const tags = docMeta?.tags
        ? docMeta.tags
            .map((tagId) => this.docDisplayConfig.getTagTitle(tagId))
            .join(",")
        : "";
      return {
        docId: doc.docId,
        docContent: doc.docContent,
        docTitle,
        tags,
        createDate: docMeta?.createDate
          ? new Date(docMeta.createDate).toISOString()
          : "",
        updatedDate: docMeta?.updatedDate
          ? new Date(docMeta.updatedDate).toISOString()
          : "",
      };
    });

    const files: VirgultumPresets.AIFileContextOption[] = this.chips.flatMap(
      (chip) => {
        if (chip.state !== "finished") return [];
        if (isFileChip(chip) && chip.blobId)
          return [
            {
              blobId: chip.blobId,
              fileName: chip.file.name,
              fileType: chip.file.type,
              fileContent: "",
            },
          ];
        if (isAttachmentChip(chip))
          return [
            {
              blobId: chip.sourceId,
              fileName: chip.name,
              fileType: "",
              fileContent: "",
            },
          ];
        return [];
      },
    );
    return { docs, files };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-chat-input": AIChatInput;
  }
}
