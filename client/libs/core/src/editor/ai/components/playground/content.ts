import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { createElement } from "react";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { PlaygroundColumns } from "./view";
import type { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import type { ServerService } from "@myoxus/core/modules/server";
import type { AppThemeService } from "@myoxus/core/modules/theme";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import type { NotificationService } from "@virgultum/core/services";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import type { AppSidebarConfig } from "../../chat-panel/chat-config";
import { AIProvider } from "../../provider";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { AIPlaygroundConfig, AIReasoningConfig } from "../ai-chat-input";

export class PlaygroundContent extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  // The custom element is only a lifecycle boundary; native components own layout.
  static override styles = css`
    playground-content,
    playground-content > lit-react-portal {
      display: contents;
    }
  `;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor doc!: Store;

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
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor aiToolsConfigService!: AIToolsConfigService;

  @property({ attribute: false })
  accessor myoxusWorkspaceDialogService!: WorkspaceDialogService;

  @property({ attribute: false })
  accessor aiModelService!: AIModelService;

  @state()
  accessor sessions: CopilotChatHistoryFragment[] = [];

  @state()
  accessor sharedInputValue: string = "";

  private rootSessionId: string | undefined = undefined;

  private isUpdatingTextareas = false;

  private isSending = false;

  private readonly getSessions = async () => {
    const sessions =
      (await AIProvider.session?.getSessions(
        this.doc.workspace.id,
        this.doc.id,
        { action: false },
      )) || [];
    const rootSession = sessions?.findLast(
      (session) => !session.parentSessionId,
    );
    if (!rootSession) {
      // Create a new session
      const rootSessionId = await AIProvider.session?.createSession({
        docId: this.doc.id,
        workspaceId: this.doc.workspace.id,
        promptName: "Chat With Myoxus AI",
      });
      if (rootSessionId) {
        this.rootSessionId = rootSessionId;
        const forkSession = await this.forkSession(rootSessionId);
        if (forkSession) {
          this.sessions = [forkSession];
        }
      }
    } else {
      this.rootSessionId = rootSession.sessionId;
      const childSessions = sessions.filter(
        (session) => session.parentSessionId === rootSession.sessionId,
      );
      if (childSessions.length > 0) {
        this.sessions = childSessions;
      } else {
        const forkSession = await this.forkSession(rootSession.sessionId);
        if (forkSession) {
          this.sessions = [forkSession];
        }
      }
    }
  };

  private readonly forkSession = async (parentSessionId: string) => {
    const forkSessionId = await AIProvider.forkChat?.({
      workspaceId: this.doc.workspace.id,
      docId: this.doc.id,
      sessionId: parentSessionId,
      latestMessageId: "",
    });
    if (!forkSessionId) {
      return;
    }
    return await AIProvider.session?.getSession(
      this.doc.workspace.id,
      forkSessionId,
    );
  };

  private readonly addChat = async () => {
    if (!this.rootSessionId) {
      return;
    }
    const forkSession = await this.forkSession(this.rootSessionId);
    if (forkSession) {
      this.sessions = [...this.sessions, forkSession];
    }
  };

  private readonly restartChat = async (sessionId: string) => {
    const replacement = this.rootSessionId
      ? await this.forkSession(this.rootSessionId)
      : undefined;
    if (!replacement) throw new Error("Playground session unavailable");
    // A deleted session must not remain the composer's next send target.
    this.sessions = this.sessions.map((session) =>
      session.sessionId === sessionId ? replacement : session,
    );
  };

  private setupTextareaSync() {
    const observer = new MutationObserver(() => {
      this.syncAllTextareas();
      this.syncAllSendButtons();
    });
    observer.observe(this, {
      childList: true,
      subtree: true,
    });
    this._disposables.add(() => observer.disconnect());
    this.syncAllTextareas();
    this.syncAllSendButtons();
  }

  private syncAllTextareas() {
    const textareas = this.getAllTextareas();
    textareas.forEach((textarea) => {
      this.setupTextareaListeners(textarea);
    });
  }

  private getAllTextareas(): HTMLTextAreaElement[] {
    return Array.from(
      this.querySelectorAll(
        'ai-chat-input textarea[data-testid="chat-panel-input"]',
      ),
    ) as HTMLTextAreaElement[];
  }

  private setupTextareaListeners(textarea: HTMLTextAreaElement) {
    if (textarea.dataset.synced) return;

    textarea.dataset.synced = "true";

    const handleInput = (event: Event) => {
      if (this.isUpdatingTextareas) return;

      const target = event.target as HTMLTextAreaElement;
      const newValue = target.value;

      if (newValue !== this.sharedInputValue) {
        this.sharedInputValue = newValue;
        this.updateOtherTextareas(target, newValue);
      }
    };

    // paste need delay to ensure the content is fully processed
    const handlePaste = (event: ClipboardEvent) => {
      if (this.isUpdatingTextareas) return;

      const target = event.target as HTMLTextAreaElement;
      setTimeout(() => {
        const newValue = target.value;
        if (newValue !== this.sharedInputValue) {
          this.sharedInputValue = newValue;
          this.updateOtherTextareas(target, newValue);
        }
      }, 0);
    };

    textarea.addEventListener("input", handleInput);
    textarea.addEventListener("paste", handlePaste);

    this._disposables.add(() => {
      textarea.removeEventListener("input", handleInput);
      textarea.removeEventListener("paste", handlePaste);
    });
  }

  private updateOtherTextareas(
    sourceTextarea: HTMLTextAreaElement,
    newValue: string,
  ) {
    this.isUpdatingTextareas = true;

    const textareas = this.getAllTextareas();
    textareas.forEach((textarea) => {
      if (textarea !== sourceTextarea && textarea.value !== newValue) {
        textarea.value = newValue;
        this.triggerInputEvent(textarea);
      }
    });

    this.isUpdatingTextareas = false;
  }

  private triggerInputEvent(textarea: HTMLTextAreaElement) {
    const inputEvent = new Event("input", { bubbles: true });
    textarea.dispatchEvent(inputEvent);
  }

  private syncAllSendButtons() {
    const sendButtons = this.getAllSendButtons();
    sendButtons.forEach((button) => {
      this.setupSendButtonListener(button);
    });
  }

  private getAllSendButtons(): HTMLElement[] {
    return Array.from(
      this.querySelectorAll('[data-testid="chat-panel-send"]'),
    ) as HTMLElement[];
  }

  private setupSendButtonListener(button: HTMLElement) {
    if (button.dataset.syncSetup) return;

    button.dataset.syncSetup = "true";

    const handleSendClick = async (_event: MouseEvent) => {
      if (this.isSending) {
        return;
      }
      this.isSending = true;
      try {
        await this.triggerOtherSendButtons(button);
      } finally {
        this.isSending = false;
      }
    };

    button.addEventListener("click", handleSendClick);

    this._disposables.add(() => {
      button.removeEventListener("click", handleSendClick);
    });
  }

  private async triggerOtherSendButtons(sourceButton: HTMLElement) {
    const allSendButtons = this.getAllSendButtons();
    const otherButtons = allSendButtons.filter(
      (button) => button !== sourceButton,
    );

    const clickPromises = otherButtons.map(async (button) => {
      try {
        const clickEvent = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        });

        button.dispatchEvent(clickEvent);
      } catch (error) {
        console.error(error);
      }
    });

    await Promise.allSettled(clickPromises);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.getSessions().catch(console.error);
    this.setupTextareaSync();
  }

  override render() {
    return (
      this.reactToLit?.(
        createElement(PlaygroundColumns, {
          items: this.sessions.map((session) => ({
            id: session.sessionId,
            content: toReactNode(
              html` <playground-chat
                .reactToLit=${this.reactToLit}
                .host=${this.host}
                .doc=${this.doc}
                .peekViewService=${this.peekViewService}
                .onOpenDoc=${this.onOpenDoc}
                .session=${session}
                .reasoningConfig=${this.reasoningConfig}
                .playgroundConfig=${this.playgroundConfig}
                .appSidebarConfig=${this.appSidebarConfig}
                .searchMenuConfig=${this.searchMenuConfig}
                .docDisplayConfig=${this.docDisplayConfig}
                .extensions=${this.extensions}
                .serverService=${this.serverService}
                .myoxusFeatureFlagService=${this.myoxusFeatureFlagService}
                .myoxusThemeService=${this.myoxusThemeService}
                .notificationService=${this.notificationService}
                .aiToolsConfigService=${this.aiToolsConfigService}
                .myoxusWorkspaceDialogService=${
                  this.myoxusWorkspaceDialogService
                }
                .aiModelService=${this.aiModelService}
                .addChat=${this.addChat}
                .onHistoryCleared=${() => this.restartChat(session.sessionId)}
              ></playground-chat>`,
            ),
          })),
        }),
        true,
      ) ?? nothing
    );
  }
}
