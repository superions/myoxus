// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  HistoryIcon,
  PinedIcon,
  PinIcon,
  PlusIcon,
  OpenInNewIcon,
} from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
} from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/editor/shared/services";
import { useState } from "react";

import type { DocDisplayConfig } from "../ai-chat-chips";
import type { ChatStatus } from "../ai-chat-messages";
import { ChatSessionHistory } from "./session-history";

export interface ChatToolbarProps {
  session: CopilotChatHistoryFragment | null | undefined;
  workspaceId: string;
  docId?: string;
  status: ChatStatus;
  docDisplayConfig: DocDisplayConfig;
  notificationService: NotificationService;
  onNewSession: () => void | Promise<void>;
  onTogglePin: () => Promise<void>;
  onExpand?: () => void;
  onOpenSession: (sessionId: string) => void | Promise<void>;
  onOpenDoc: (docId: string, sessionId: string) => void | Promise<void>;
  onSessionDelete: (
    session: VirgultumPresets.AIRecentSession,
  ) => void | Promise<void>;
}

/** Shared native session chrome. Hosts retain session/draft/request ownership. */
export function ChatToolbar(props: ChatToolbarProps) {
  const {
    session,
    workspaceId,
    status,
    docDisplayConfig,
    notificationService,
  } = props;
  const t = useI18n();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const generating = status === "loading" || status === "transmitting";
  const disabled = generating || pending;
  const pinLabel = session?.pinned
    ? t["com.myoxus.ai.chat-panel.unpin-chat"]()
    : t["com.myoxus.ai.chat-panel.pin-chat"]();

  const confirmUnpin = async () => {
    if (!session?.pinned) return true;
    const confirmed = await notificationService.confirm({
      title: t["com.myoxus.ai.chat-panel.switch-title"](),
      message: t["com.myoxus.ai.chat-panel.switch-message"](),
      confirmText: t["com.myoxus.ai.chat-panel.switch-action"](),
      cancelText: t["Cancel"](),
    });
    if (!confirmed) return false;
    try {
      await props.onTogglePin();
      return true;
    } catch {
      notificationService.toast(t["com.myoxus.ai.chat-panel.pin-failed"]());
      return false;
    }
  };

  const transition = async (
    action: () => void | Promise<void>,
    unpin: boolean,
    pinAction = false,
    keepHistoryOpen = false,
  ) => {
    if (disabled) return;
    if (!keepHistoryOpen) setHistoryOpen(false);
    setPending(true);
    try {
      if (!unpin || (await confirmUnpin())) await action();
    } catch {
      notificationService.toast(
        t[
          pinAction
            ? "com.myoxus.ai.chat-panel.pin-failed"
            : "com.myoxus.ai.chat-panel.session-error"
        ](),
      );
    } finally {
      setPending(false);
      // A native confirmation portal may close the popover while it owns focus.
      // Restore the requested history surface after completion/cancellation.
      if (keepHistoryOpen) setHistoryOpen(true);
    }
  };

  return (
    <Group data-myoxus-ui-role="chat-session-toolbar">
      <IconButton
        size="small"
        aria-label={t["com.myoxus.ai.chat-panel.new-chat"]()}
        tooltip={t["com.myoxus.ai.chat-panel.new-chat"]()}
        data-testid="ai-panel-new-chat"
        disabled={disabled}
        onClick={() => void transition(props.onNewSession, true)}
      >
        <PlusIcon />
      </IconButton>
      <IconButton
        size="small"
        aria-label={pinLabel}
        tooltip={pinLabel}
        aria-pressed={!!session?.pinned}
        data-testid="ai-panel-pin-chat"
        disabled={disabled}
        onClick={() => void transition(props.onTogglePin, false, true)}
      >
        {session?.pinned ? <PinedIcon /> : <PinIcon />}
      </IconButton>
      <Popover
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        position="bottom-end"
        contentMeasure="reading"
        fitViewport
        returnFocus
        trapFocus
        closeOnEscape
      >
        <PopoverTarget>
          <IconButton
            size="small"
            aria-label={t["com.myoxus.ai.chat-panel.history"]()}
            tooltip={t["com.myoxus.ai.chat-panel.history"]()}
            tooltipOptions={{ opened: historyOpen ? false : undefined }}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <HistoryIcon />
          </IconButton>
        </PopoverTarget>
        <PopoverContent
          role="dialog"
          aria-label={t["com.myoxus.ai.chat-panel.history"]()}
        >
          {historyOpen ? (
            <ChatSessionHistory
              key={workspaceId}
              workspaceId={workspaceId}
              sessionId={session?.sessionId}
              disabled={disabled}
              docDisplayConfig={docDisplayConfig}
              onSelect={(id) => {
                if (id === session?.sessionId) {
                  setHistoryOpen(false);
                  notificationService.toast(
                    t["com.myoxus.ai.chat-panel.already-open"](),
                  );
                } else void transition(() => props.onOpenSession(id), true);
              }}
              onOpenDoc={(doc, id) => {
                if (doc === props.docId && id === session?.sessionId) {
                  setHistoryOpen(false);
                  notificationService.toast(
                    t["com.myoxus.ai.chat-panel.already-open"](),
                  );
                } else
                  void transition(
                    () => props.onOpenDoc(doc, id),
                    doc !== props.docId,
                  );
              }}
              onDelete={(item) =>
                transition(
                  () => props.onSessionDelete(item),
                  false,
                  false,
                  true,
                )
              }
            />
          ) : null}
        </PopoverContent>
      </Popover>
      {props.onExpand ? (
        <IconButton
          size="small"
          data-testid="chat-open-main"
          aria-label={t["com.myoxus.ai.chat-panel.open-workspace-chat"]()}
          tooltip={t["com.myoxus.ai.chat-panel.open-workspace-chat"]()}
          disabled={disabled}
          onClick={props.onExpand}
        >
          <OpenInNewIcon />
        </IconButton>
      ) : null}
    </Group>
  );
}
