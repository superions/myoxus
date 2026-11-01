// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { DeleteIcon, OpenInNewIcon } from "@myoxus/icons/react";
import { toReactNode } from "@myoxus/lit-react";
import {
  Button,
  Group,
  IconButton,
  MyoxusLoader,
  MyoxusText,
  NavLink,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

import { AIProvider } from "../../provider";
import type { DocDisplayConfig } from "../ai-chat-chips";

type RecentSession = VirgultumPresets.AIRecentSession;
const PAGE_SIZE = 10;

export interface ChatSessionHistoryProps {
  workspaceId: string;
  sessionId?: string;
  disabled: boolean;
  docDisplayConfig: DocDisplayConfig;
  onSelect: (sessionId: string) => void;
  onOpenDoc: (docId: string, sessionId: string) => void;
  onDelete: (session: RecentSession) => void | Promise<void>;
}

function SessionHistoryEntry({
  session,
  selected,
  disabled,
  docDisplayConfig,
  onSelect,
  onOpenDoc,
  onDelete,
}: Pick<
  ChatSessionHistoryProps,
  "disabled" | "docDisplayConfig" | "onSelect" | "onOpenDoc" | "onDelete"
> & { session: RecentSession; selected: boolean }) {
  const t = useI18n();
  const [docTitle, setDocTitle] = useState(
    session.docId ? docDisplayConfig.getTitle(session.docId) : "",
  );
  useEffect(() => {
    if (!session.docId) return;
    const title = docDisplayConfig.getTitleSignal(session.docId);
    const unsubscribe = title.signal.subscribe(setDocTitle);
    return () => {
      unsubscribe();
      title.cleanup();
    };
  }, [docDisplayConfig, session.docId]);
  const icon = session.docId ? docDisplayConfig.getIcon(session.docId) : null;
  return (
    <Group wrap="nowrap" data-session-id={session.sessionId}>
      <NavLink
        component="button"
        type="button"
        active={selected}
        disabled={disabled}
        label={session.title || t["com.myoxus.ai.chat-panel.new-chat"]()}
        description={
          docTitle ||
          new Intl.DateTimeFormat(t.language, {
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(session.updatedAt))
        }
        onClick={() => onSelect(session.sessionId)}
      />
      {session.docId ? (
        <IconButton
          aria-label={t["com.myoxus.database.document_link.open"]()}
          tooltip={docTitle}
          disabled={disabled}
          onClick={() => onOpenDoc(session.docId!, session.sessionId)}
        >
          {icon ? (
            toReactNode(typeof icon === "function" ? icon() : icon)
          ) : (
            <OpenInNewIcon />
          )}
        </IconButton>
      ) : null}
      <IconButton
        aria-label={t["Delete"]()}
        tooltip={t["Delete"]()}
        disabled={disabled}
        onClick={() => onDelete(session)}
      >
        <DeleteIcon />
      </IconButton>
    </Group>
  );
}

/** View-local pagination over the existing session provider, not a history store. */
export function ChatSessionHistory({
  workspaceId,
  sessionId,
  disabled,
  docDisplayConfig,
  onSelect,
  onOpenDoc,
  onDelete,
}: ChatSessionHistoryProps) {
  const t = useI18n();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setFailed(false);
    const provider = AIProvider.session;
    const request = provider
      ? provider.getRecentSessions(workspaceId, PAGE_SIZE, offset)
      : Promise.reject(new Error("Session provider unavailable"));
    request
      .then((more) => {
        if (disposed) return;
        if (!more) throw new Error("Session history unavailable");
        const next = more.sessions;
        setSessions((previous) =>
          offset === 0 ? next : [...previous, ...next],
        );
        setHasMore(more.hasNextPage);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    // A closed popup or changed workspace must not receive an old page result.
    return () => {
      disposed = true;
    };
  }, [workspaceId, offset, retry]);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDays = new Date(today);
  sevenDays.setDate(today.getDate() - 6);
  const thirtyDays = new Date(today);
  thirtyDays.setDate(today.getDate() - 29);
  const grouped: RecentSession[][] = [[], [], [], []];
  for (const session of sessions) {
    const updated = new Date(session.updatedAt);
    grouped[
      updated >= today
        ? 0
        : updated >= sevenDays
          ? 1
          : updated >= thirtyDays
            ? 2
            : 3
    ].push(session);
  }
  const labels = [
    t["com.myoxus.today"](),
    t["com.myoxus.last7Days"](),
    t["com.myoxus.last30Days"](),
    t["com.myoxus.moreThan30Days"](),
  ];

  return (
    <Scrollable.Root>
      <Scrollable.Viewport
        autosize
        maxHeight="floating"
        scrollbars="y"
        aria-label={t["com.myoxus.ai.chat-panel.history"]()}
        onScroll={(event) => {
          if (loading || failed || !hasMore) return;
          const viewport = event.currentTarget;
          if (
            viewport.scrollTop + viewport.clientHeight >=
            viewport.scrollHeight - viewport.clientHeight * 0.15
          )
            setOffset(sessions.length);
        }}
      >
        <Stack data-myoxus-ui-role="chat-session-history">
          <MyoxusText>{t["com.myoxus.ai.chat-panel.history"]()}</MyoxusText>
          {grouped.map((group, index) =>
            group.length ? (
              <Stack key={index}>
                <MyoxusText typographySlot="caption" tone="secondary">
                  {labels[index]}
                </MyoxusText>
                {group.map((session) => (
                  <SessionHistoryEntry
                    key={session.sessionId}
                    session={session}
                    selected={sessionId === session.sessionId}
                    disabled={disabled || loading}
                    docDisplayConfig={docDisplayConfig}
                    onSelect={onSelect}
                    onOpenDoc={onOpenDoc}
                    onDelete={async (session) => {
                      await onDelete(session);
                      // Requery the authoritative first page after the dialog/RPC;
                      // cancellation/failure must not optimistically hide a row.
                      setOffset(0);
                      setRetry((value) => value + 1);
                    }}
                  />
                ))}
              </Stack>
            ) : null,
          )}
          {loading ? <MyoxusLoader /> : null}
          {!loading && !failed && sessions.length === 0 ? (
            <MyoxusText tone="secondary">
              {t["com.myoxus.ai.chat-panel.history-empty"]()}
            </MyoxusText>
          ) : null}
          {failed ? (
            <Stack role="alert">
              <MyoxusText>
                {t["com.myoxus.ai.chat-panel.history-error"]()}
              </MyoxusText>
              <Button onClick={() => setRetry((value) => value + 1)}>
                {t["Retry"]()}
              </Button>
            </Stack>
          ) : null}
        </Stack>
      </Scrollable.Viewport>
    </Scrollable.Root>
  );
}
