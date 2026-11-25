// SPDX-License-Identifier: MIT

import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import type { NotificationService } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { useCallback, useEffect, useRef, useState } from "react";

import { AIProvider } from "../../provider";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { AIReasoningConfig } from "../ai-chat-input";
import { PlaygroundChat } from "./chat";
import { PlaygroundColumns } from "./view";

export interface PlaygroundContentProps {
  host: EditorHost;
  doc: Store;
  peekViewService: PeekViewService;
  onOpenDoc: (docId: string, sessionId?: string) => void;
  reasoningConfig: AIReasoningConfig;
  searchMenuConfig: SearchMenuConfig;
  docDisplayConfig: DocDisplayConfig;
  notificationService: NotificationService;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
}

export function PlaygroundContent({
  host,
  doc,
  peekViewService,
  onOpenDoc,
  reasoningConfig,
  searchMenuConfig,
  docDisplayConfig,
  notificationService,
  aiToolsConfigService,
  aiModelService,
}: PlaygroundContentProps) {
  const [sessions, setSessions] = useState<CopilotChatHistoryFragment[]>([]);
  const [sharedDraft, setSharedDraft] = useState("");
  const rootSessionIdRef = useRef<string | undefined>(undefined);
  const sendHandlersRef = useRef(new Map<string, () => void>());
  const isBroadcastingRef = useRef(false);

  const forkSession = useCallback(
    async (parentSessionId: string) => {
      const forkSessionId = await AIProvider.forkChat?.({
        workspaceId: doc.workspace.id,
        docId: doc.id,
        sessionId: parentSessionId,
        latestMessageId: "",
      });
      if (!forkSessionId) return;
      return await AIProvider.session?.getSession(
        doc.workspace.id,
        forkSessionId,
      );
    },
    [doc],
  );

  useEffect(() => {
    let active = true;
    const loadSessions = async () => {
      const all =
        (await AIProvider.session?.getSessions(doc.workspace.id, doc.id, {
          action: false,
        })) || [];
      if (!active) return;
      const rootSession = all.findLast((s) => !s.parentSessionId);
      if (!rootSession) {
        const rootSessionId = await AIProvider.session?.createSession({
          docId: doc.id,
          workspaceId: doc.workspace.id,
          promptName: "Chat With Myoxus AI",
        });
        if (!active || !rootSessionId) return;
        rootSessionIdRef.current = rootSessionId;
        const forked = await forkSession(rootSessionId);
        if (active && forked) setSessions([forked]);
      } else {
        rootSessionIdRef.current = rootSession.sessionId;
        const childSessions = all.filter(
          (s) => s.parentSessionId === rootSession.sessionId,
        );
        if (childSessions.length > 0) {
          setSessions(childSessions);
        } else {
          const forked = await forkSession(rootSession.sessionId);
          if (active && forked) setSessions([forked]);
        }
      }
    };
    void loadSessions().catch(console.error);
    return () => {
      active = false;
    };
  }, [doc, forkSession]);

  const addChat = useCallback(async () => {
    if (!rootSessionIdRef.current) return;
    const forked = await forkSession(rootSessionIdRef.current);
    if (forked) setSessions((prev) => [...prev, forked]);
  }, [forkSession]);

  const restartChat = useCallback(
    async (sessionId: string) => {
      const replacement = rootSessionIdRef.current
        ? await forkSession(rootSessionIdRef.current)
        : undefined;
      if (!replacement) throw new Error("Playground session unavailable");
      // A deleted session must not remain the composer's next send target.
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? replacement : s)),
      );
    },
    [forkSession],
  );

  const broadcastSend = useCallback((sourceSessionId: string) => {
    if (isBroadcastingRef.current) return;
    isBroadcastingRef.current = true;
    try {
      for (const [id, trigger] of sendHandlersRef.current) {
        if (id !== sourceSessionId) trigger();
      }
    } finally {
      isBroadcastingRef.current = false;
    }
  }, []);

  return (
    <PlaygroundColumns
      items={sessions.map((session) => ({
        id: session.sessionId,
        content: (
          <PlaygroundChat
            host={host}
            doc={doc}
            peekViewService={peekViewService}
            onOpenDoc={onOpenDoc}
            session={session}
            reasoningConfig={reasoningConfig}
            searchMenuConfig={searchMenuConfig}
            docDisplayConfig={docDisplayConfig}
            notificationService={notificationService}
            aiToolsConfigService={aiToolsConfigService}
            aiModelService={aiModelService}
            addChat={addChat}
            onHistoryCleared={() => restartChat(session.sessionId)}
            syncedDraft={sharedDraft}
            onSyncedDraftChange={setSharedDraft}
            onRegisterSend={(fn) => {
              sendHandlersRef.current.set(session.sessionId, fn);
              return () => {
                sendHandlersRef.current.delete(session.sessionId);
              };
            }}
            onBroadcastSend={() => broadcastSend(session.sessionId)}
          />
        ),
      }))}
    />
  );
}
