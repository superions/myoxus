import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { type NotificationService } from "@virgultum/editor/shared/services";
import type { ReactToLit } from "@myoxus/lit-react";
import { IconButton } from "@myoxus/ui-facade";
import { TrashIcon } from "@myoxus/icons/react";
import { createElement } from "react";
import { chatI18n } from "../chat-i18n";
import { ShadowlessElement } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { nothing } from "lit";
import { property } from "lit/decorators.js";

import { AIProvider } from "../../provider";
import type { ChatContextValue } from "../ai-chat-content";

export class AIHistoryClear extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false })
  accessor chatContextValue!: ChatContextValue;

  @property({ attribute: false })
  accessor session!: CopilotChatHistoryFragment | null | undefined;

  @property({ attribute: false })
  accessor notificationService!: NotificationService;

  @property({ attribute: false })
  accessor doc!: Store;

  @property({ attribute: false })
  accessor onHistoryCleared!: () => void | Promise<void>;

  @property({ attribute: false }) accessor reactToLit!: ReactToLit;

  private get _isHistoryClearDisabled() {
    return (
      this.chatContextValue.status === "loading" ||
      this.chatContextValue.status === "transmitting" ||
      !this.chatContextValue.messages.length ||
      !this.session
    );
  }

  private readonly _cleanupHistories = async () => {
    if (this._isHistoryClearDisabled || !this.session) {
      return;
    }
    const sessionId = this.session.sessionId;
    try {
      const confirm = await this.notificationService.confirm({
        title:
          chatI18n()["com.myoxus.ai.chat-panel.session.delete.confirm.title"](),
        message:
          chatI18n()[
            "com.myoxus.ai.chat-panel.session.delete.confirm.message"
          ](),
        confirmText: chatI18n()["Confirm"](),
        cancelText: chatI18n()["Cancel"](),
      });

      if (confirm) {
        await AIProvider.histories?.cleanup(
          this.doc.workspace.id,
          this.doc.id,
          sessionId ? [sessionId] : [],
        );
        await this.onHistoryCleared?.();
        this.notificationService.toast(
          chatI18n()["com.myoxus.ai.chat-panel.session.delete.toast.success"](),
        );
      }
    } catch {
      this.notificationService.toast(
        chatI18n()["com.myoxus.ai.chat-panel.session.delete.toast.failed"](),
      );
    }
  };

  override render() {
    if (!this.reactToLit) return nothing;
    const label =
      chatI18n()["com.myoxus.ai.chat-panel.session.delete.confirm.title"]();
    return this.reactToLit(
      createElement(
        IconButton,
        {
          size: "small",
          tooltip: label,
          "aria-label": label,
          "data-testid": "chat-panel-clear",
          disabled: this._isHistoryClearDisabled,
          onClick: this._cleanupHistories,
        },
        createElement(TrashIcon),
      ),
      true,
    );
  }
}
