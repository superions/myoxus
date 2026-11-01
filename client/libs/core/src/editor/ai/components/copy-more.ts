// SPDX-License-Identifier: MIT
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import {
  type EditorHost,
  ShadowlessElement,
  type TextSelection,
  type BlockSelection,
} from "@virgultum/editor/std";
import type { ImageSelection } from "@virgultum/editor/shared/selection";
import type { NotificationService } from "@virgultum/shared/services";
import { nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { createElement } from "react";
import { Stack } from "@myoxus/ui-facade";
import { DownloadIcon } from "@myoxus/icons/react";
import { AIProvider } from "../provider";
import type { CopilotGeneratedFile } from "./ai-chat-messages/type";
import { GeneratedFilesView } from "./generated-files-view";

import type { ChatAction } from "../_common/chat-actions-handle";
import { copyText } from "../utils/editor-actions";
import { chatI18n } from "./chat-i18n";
import { ChatMessageActions } from "./copy-more-view";

/** Command callbacks retain editor/session ownership; the native menu owns UI. */
export class ChatCopyMore extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor host: EditorHost | null | undefined;
  @property({ attribute: false }) accessor actions: ChatAction[] = [];
  @property({ attribute: false }) accessor session:
    CopilotChatHistoryFragment | null | undefined;
  @property({ attribute: false }) accessor content = "";
  @property({ attribute: false }) accessor messageId: string | undefined;
  @property({ attribute: false }) accessor isLast = false;
  @property({ attribute: false }) accessor withMargin = false;
  @property({ attribute: false }) accessor retry: () => void | Promise<void> =
    () => {};
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "chat-actions";
  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor generatedFiles: CopilotGeneratedFile[] = [];
  @property({ attribute: false }) accessor exportable = false;
  @state() private accessor exportedFiles: CopilotGeneratedFile[] = [];
  @state() private accessor filePending = false;
  @state() private accessor fileFailed = false;

  private async exportFile(format: "pdf" | "html") {
    const id = this.messageId;
    const session = AIProvider.session;
    if (
      !id ||
      !session?.exportMessage ||
      !session.downloadGeneratedFile ||
      this.filePending
    )
      return;
    this.filePending = true;
    this.fileFailed = false;
    try {
      const file = await session.exportMessage(id, format);
      // A detached/retargeted host never downloads into the next conversation.
      if (!this.isConnected || this.messageId !== id) return;
      this.exportedFiles = [
        ...this.exportedFiles.filter((value) => value.id !== file.id),
        file,
      ];
      await session.downloadGeneratedFile(file);
    } catch {
      if (this.isConnected && this.messageId === id) this.fileFailed = true;
    } finally {
      if (this.isConnected && this.messageId === id) this.filePending = false;
    }
  }
  private async downloadFile(file: CopilotGeneratedFile) {
    const id = this.messageId;
    const download = AIProvider.session?.downloadGeneratedFile;
    if (!download || this.filePending) return;
    this.filePending = true;
    this.fileFailed = false;
    try {
      await download(file);
    } catch {
      if (this.isConnected && this.messageId === id) this.fileFailed = true;
    } finally {
      if (this.isConnected && this.messageId === id) this.filePending = false;
    }
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("messageId")) {
      this.exportedFiles = [];
      this.filePending = false;
      this.fileFailed = false;
    }
  }

  private notify(title: string) {
    this.notificationService.notify({
      title,
      accent: "success",
      onClose: () => {},
    });
  }

  override render() {
    if (!this.reactToLit) return nothing;
    const { host, content, messageId, session } = this;
    const actions = host
      ? this.actions
          .filter((action) => action.showWhen(host))
          .map((action, index) => ({
            id: String(index),
            label: action.title,
            icon: toReactNode(action.icon),
            run: async () => {
              const selected = host.selection.value;
              const success = await action.handler(
                host,
                content,
                {
                  text: selected.find((value) => value.type === "text") as
                    TextSelection | undefined,
                  blocks: selected.filter(
                    (value) => value.type === "block",
                  ) as BlockSelection[],
                  images: selected.filter(
                    (value) => value.type === "image",
                  ) as ImageSelection[],
                },
                session?.sessionId,
                messageId,
              );
              if (success) this.notify(action.toast);
            },
          }))
      : [];
    if (this.exportable && messageId && AIProvider.session?.exportMessage) {
      actions.push(
        {
          id: "export-pdf",
          label: chatI18n()["com.myoxus.export.pdf.menu-label"](),
          icon: createElement(DownloadIcon),
          run: () => this.exportFile("pdf"),
        },
        {
          id: "export-html",
          label: chatI18n()["Export to HTML"](),
          icon: createElement(DownloadIcon),
          run: () => this.exportFile("html"),
        },
      );
    }
    const files = [
      ...new Map(
        [...this.generatedFiles, ...this.exportedFiles].map((file) => [
          file.id,
          file,
        ]),
      ).values(),
    ];
    return this.reactToLit(
      createElement(
        Stack,
        null,
        createElement(ChatMessageActions, {
          copy: content
            ? async () => {
                if (await copyText(content))
                  this.notify(chatI18n()["Copied to clipboard"]());
              }
            : undefined,
          retry: this.isLast ? this.retry : undefined,
          actions,
          onFailure: () =>
            this.notificationService.toast(
              chatI18n()["com.myoxus.ai.chat-panel.error"](),
            ),
        }),
        files.length || this.filePending || this.fileFailed
          ? createElement(GeneratedFilesView, {
              files,
              pending: this.filePending,
              failed: this.fileFailed,
              download: (file: CopilotGeneratedFile) =>
                void this.downloadFile(file),
            })
          : null,
      ),
      true,
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-copy-more": ChatCopyMore;
  }
}
