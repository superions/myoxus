import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { describe, expect, test, vi } from "vitest";

import {
  resolveInitialSession,
  consumeSessionIdFromUrl,
  type SessionService,
  type WorkbenchLike,
} from "./session";

const createWorkbench = (search: string) => {
  const updateQueryString = vi.fn();
  const workbench = {
    location$: { value: { search } },
    activeView$: { value: { updateQueryString } },
  } satisfies WorkbenchLike;

  return { workbench, updateQueryString };
};

const doc = { id: "doc-1", workspace: { id: "ws-1" } };

test("returns undefined without session service or doc", async () => {
  await expect(
    resolveInitialSession({ sessionService: null, doc, workbench: null }),
  ).resolves.toBeUndefined();
  await expect(
    resolveInitialSession({
      sessionService: {
        getSessions: vi.fn(),
        getSession: vi.fn(),
      },
      doc: null,
      workbench: null,
    }),
  ).resolves.toBeUndefined();
});

describe("resolveInitialSession", () => {
  test("prefers pinned session and leaves URL consumption to the active host", async () => {
    const pinnedSession = {
      sessionId: "pinned-session",
      pinned: true,
    } as CopilotChatHistoryFragment;

    const sessionService: SessionService = {
      getSessions: vi.fn().mockResolvedValueOnce([pinnedSession]),
      getSession: vi.fn(),
    };

    const { workbench, updateQueryString } = createWorkbench(
      "?sessionId=from-url",
    );

    const result = await resolveInitialSession({
      sessionService,
      doc,
      workbench,
    });

    expect(result).toBe(pinnedSession);
    expect(updateQueryString).not.toHaveBeenCalled();
    consumeSessionIdFromUrl(workbench, "from-url");
    expect(updateQueryString).toHaveBeenCalledWith(
      { sessionId: undefined },
      { replace: true },
    );
    expect(sessionService.getSession).not.toHaveBeenCalled();
  });

  test("loads session from url when no pinned session", async () => {
    const sessionFromUrl = {
      sessionId: "url-session",
      pinned: false,
    } as CopilotChatHistoryFragment;

    const sessionService: SessionService = {
      getSessions: vi.fn().mockResolvedValueOnce([]),
      getSession: vi.fn().mockResolvedValueOnce(sessionFromUrl),
    };

    const { workbench, updateQueryString } = createWorkbench(
      "?sessionId=url-session",
    );

    const result = await resolveInitialSession({
      sessionService,
      doc,
      workbench,
    });

    expect(result).toBe(sessionFromUrl);
    expect(sessionService.getSession).toHaveBeenCalledWith(
      doc.workspace.id,
      "url-session",
    );
    expect(updateQueryString).not.toHaveBeenCalled();
    workbench.location$.value.search = "?sessionId=newer-navigation";
    consumeSessionIdFromUrl(workbench, "url-session");
    expect(updateQueryString).not.toHaveBeenCalled();
    workbench.location$.value.search = "?sessionId=url-session";
    consumeSessionIdFromUrl(workbench, "url-session");
    expect(updateQueryString).toHaveBeenCalledWith(
      { sessionId: undefined },
      { replace: true },
    );
  });

  test("falls back to latest doc session", async () => {
    const docSession = {
      sessionId: "doc-session",
      pinned: false,
    } as CopilotChatHistoryFragment;

    const sessionService: SessionService = {
      getSessions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([docSession]),
      getSession: vi.fn(),
    };

    const { workbench } = createWorkbench("");

    const result = await resolveInitialSession({
      sessionService,
      doc,
      workbench,
    });

    expect(result).toBe(docSession);
    expect(sessionService.getSessions).toHaveBeenCalledWith(
      doc.workspace.id,
      doc.id,
      { action: false, fork: false, limit: 1 },
    );
  });

  test("missing URL conversation fails recoverably without consuming the handoff", async () => {
    const sessionService: SessionService = {
      getSessions: vi.fn().mockResolvedValueOnce([]),
      getSession: vi.fn().mockResolvedValueOnce(null),
    };

    const { workbench, updateQueryString } =
      createWorkbench("?sessionId=missing");

    await expect(
      resolveInitialSession({
        sessionService,
        doc,
        workbench,
      }),
    ).rejects.toThrow("Requested conversation unavailable");
    expect(updateQueryString).not.toHaveBeenCalled();
  });
});
