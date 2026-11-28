// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { CopilotChatHistoryFragment } from "@myoxus/graphql";

interface SessionListFilter {
  pinned?: boolean;
  action?: boolean;
  fork?: boolean;
  limit?: number;
}

export interface SessionService {
  getSessions: (
    workspaceId: string,
    docId?: string,
    options?: SessionListFilter,
  ) => Promise<CopilotChatHistoryFragment[] | null | undefined>;
  getSession: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<CopilotChatHistoryFragment | null | undefined>;
}

export interface WorkbenchLike {
  location$: {
    value: {
      search: string;
    };
  };
  activeView$: {
    value: {
      updateQueryString: (
        patch: Record<string, unknown>,
        options?: { replace?: boolean },
      ) => void;
    };
  };
}

export interface DocLike {
  id: string;
  workspace: {
    id: string;
  };
}

export function getSessionIdFromUrl(
  workbench?: WorkbenchLike | null,
): string | undefined {
  if (!workbench) {
    return undefined;
  }
  return (
    new URLSearchParams(workbench.location$.value.search).get("sessionId") ??
    undefined
  );
}

/**
 * Clears `?sessionId=` only if the active URL still matches the handoff that
 * initiated resolution, preventing stale async responses from erasing newer
 * navigation parameters.
 */
export function consumeSessionIdFromUrl(
  workbench: WorkbenchLike,
  expected: string | undefined,
): void {
  if (expected && getSessionIdFromUrl(workbench) === expected) {
    workbench.activeView$.value.updateQueryString(
      { sessionId: undefined },
      { replace: true },
    );
  }
}

/**
 * Resolves the initial AI chat session in priority order without mutating the
 * URL: pinned workspace session, explicit `?sessionId=` handoff, latest
 * non-action/non-fork document session, or `null` for a fresh chat.
 */
export async function resolveInitialSession({
  sessionService,
  doc,
  workbench,
}: {
  sessionService?: SessionService | null;
  doc?: DocLike | null;
  workbench?: WorkbenchLike | null;
}): Promise<CopilotChatHistoryFragment | null | undefined> {
  if (!sessionService || !doc) {
    return undefined;
  }

  const requestedSessionId = getSessionIdFromUrl(workbench);

  const pinnedSessions = await sessionService.getSessions(
    doc.workspace.id,
    undefined,
    { pinned: true, limit: 1 },
  );
  if (!Array.isArray(pinnedSessions)) {
    throw new Error("Session lookup unavailable");
  }
  if (pinnedSessions[0]) {
    return pinnedSessions[0];
  }

  if (requestedSessionId) {
    const requestedSession = await sessionService.getSession(
      doc.workspace.id,
      requestedSessionId,
    );
    if (!requestedSession) {
      throw new Error("Requested conversation unavailable");
    }
    return requestedSession;
  }

  const docSessions = await sessionService.getSessions(
    doc.workspace.id,
    doc.id,
    { action: false, fork: false, limit: 1 },
  );
  if (!Array.isArray(docSessions)) {
    throw new Error("Session lookup unavailable");
  }

  return docSessions[0] ?? null;
}
