/**
 * Chat-panel session utilities — session initialisation and URL handoff logic.
 *
 * Provides two public functions used by `EditorChatPanel` (and the workspace
 * chat page) to determine which AI session to display on mount:
 *
 * Resolution does not mutate the URL. The host consumes a handoff only after
 * checking that the result still belongs to its active document/request.
 *
 * ### `resolveInitialSession`
 * Implements the session-priority waterfall used on chat-panel mount:
 *
 * 1. **Pinned session** — if the workspace has a pinned session it always
 *    takes precedence, regardless of the current document or URL.
 * 2. **URL session** — if `?sessionId=` was present, fetch and display that
 *    specific conversation (e.g. from a notification or cross-panel link).
 * 3. **Latest doc session** — fall back to the most recent chat session that
 *    belongs to the current document (excluding action and fork sessions).
 * 4. **null** — no prior conversation; the panel starts fresh.
 *
 * The function returns `undefined` when the required services are not yet
 * available (early return before any async work is done), allowing callers to
 * retry when the services become ready.
 */

import type { CopilotChatHistoryFragment } from "@myoxus/graphql";

/** Filter options accepted by `SessionService.getSessions`. */
type SessionListOptions = {
  pinned?: boolean;
  action?: boolean;
  fork?: boolean;
  limit?: number;
};

/**
 * Minimal interface over `CopilotClient` required by the session-resolution
 * logic.  Typed narrowly so it can be satisfied by mock objects in tests.
 */
export interface SessionService {
  getSessions: (
    workspaceId: string,
    docId?: string,
    options?: SessionListOptions,
  ) => Promise<CopilotChatHistoryFragment[] | null | undefined>;
  getSession: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<CopilotChatHistoryFragment | null | undefined>;
}

/**
 * Structural interface over `Workbench` needed to read and clear the URL
 * `sessionId` query parameter.  Using a structural type keeps this module
 * free of a direct dependency on the workbench module.
 */
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

/** Structural interface for the minimal doc shape needed for session resolution. */
export interface DocLike {
  id: string;
  workspace: {
    id: string;
  };
}

export const getSessionIdFromUrl = (workbench?: WorkbenchLike | null) => {
  if (!workbench) {
    return undefined;
  }
  const searchParams = new URLSearchParams(workbench.location$.value.search);
  return searchParams.get("sessionId") ?? undefined;
};

/** A late resolution must not consume a different navigation's handoff. */
export const consumeSessionIdFromUrl = (
  workbench: WorkbenchLike,
  expected: string | undefined,
) => {
  if (expected && getSessionIdFromUrl(workbench) === expected) {
    workbench.activeView$.value.updateQueryString(
      { sessionId: undefined },
      { replace: true },
    );
  }
};

export const resolveInitialSession = async ({
  sessionService,
  doc,
  workbench,
}: {
  sessionService?: SessionService | null;
  doc?: DocLike | null;
  workbench?: WorkbenchLike | null;
}): Promise<CopilotChatHistoryFragment | null | undefined> => {
  if (!sessionService || !doc) {
    return undefined;
  }

  const sessionId = getSessionIdFromUrl(workbench);

  const pinSessions = await sessionService.getSessions(
    doc.workspace.id,
    undefined,
    {
      pinned: true,
      limit: 1,
    },
  );
  if (!Array.isArray(pinSessions))
    throw new Error("Session lookup unavailable");

  if (Array.isArray(pinSessions) && pinSessions[0]) {
    return pinSessions[0];
  }

  if (sessionId) {
    const session = await sessionService.getSession(
      doc.workspace.id,
      sessionId,
    );
    if (!session) throw new Error("Requested conversation unavailable");
    return session;
  }

  const docSessions = await sessionService.getSessions(
    doc.workspace.id,
    doc.id,
    {
      action: false,
      fork: false,
      limit: 1,
    },
  );
  if (!Array.isArray(docSessions))
    throw new Error("Session lookup unavailable");

  return docSessions?.[0] ?? null;
};
