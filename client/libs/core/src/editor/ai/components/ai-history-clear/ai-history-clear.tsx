// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { TrashIcon } from "@myoxus/icons/react";
import { IconButton } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/editor/shared/services";
import type { Store } from "@virgultum/editor/store";
import { useCallback } from "react";

import { AIProvider } from "../../provider";
import type { ChatContextValue } from "../ai-chat-content/type";

export function AIHistoryClear({
  chatContextValue,
  session,
  notificationService,
  doc,
  onHistoryCleared,
}: {
  chatContextValue: Pick<ChatContextValue, "status" | "messages">;
  session: CopilotChatHistoryFragment | null | undefined;
  notificationService: NotificationService;
  doc: Store;
  onHistoryCleared?: () => void | Promise<void>;
}) {
  const t = useI18n();
  const isBusy =
    chatContextValue.status === "loading" ||
    chatContextValue.status === "transmitting";
  const disabled = isBusy || !chatContextValue.messages.length || !session;

  const clearHistory = useCallback(async () => {
    if (disabled || !session) return;
    try {
      const confirmed = await notificationService.confirm({
        title: t["com.myoxus.ai.chat-panel.session.delete.confirm.title"](),
        message: t["com.myoxus.ai.chat-panel.session.delete.confirm.message"](),
        confirmText: t["Confirm"](),
        cancelText: t["Cancel"](),
      });
      if (!confirmed) return;

      await AIProvider.histories?.cleanup(
        doc.workspace.id,
        doc.id,
        session.sessionId ? [session.sessionId] : [],
      );
      await onHistoryCleared?.();
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.success"](),
      );
    } catch {
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.failed"](),
      );
    }
  }, [disabled, doc, notificationService, onHistoryCleared, session, t]);

  const label = t["com.myoxus.ai.chat-panel.session.delete.confirm.title"]();

  return (
    <IconButton
      size="small"
      tooltip={label}
      aria-label={label}
      data-testid="chat-panel-clear"
      disabled={disabled}
      onClick={() => void clearHistory()}
    >
      <TrashIcon />
    </IconButton>
  );
}
