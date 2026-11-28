// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { describe, expect, test, vi } from "vitest";

import {
  consumeSessionIdFromUrl,
  resolveInitialSession,
  type SessionService,
  type WorkbenchLike,
} from "./session";

function makeWorkbench(search: string) {
  const updateQueryString = vi.fn();
  const workbench: WorkbenchLike = {
    location$: { value: { search } },
    activeView$: { value: { updateQueryString } },
  };
  return { workbench, updateQueryString };
}

const sampleDoc = { id: "doc-1", workspace: { id: "ws-1" } };

describe("resolveInitialSession", () => {
  test("returns undefined until both session service and document are ready", async () => {
    await expect(
      resolveInitialSession({
        sessionService: null,
        doc: sampleDoc,
        workbench: null,
      }),
    ).resolves.toBeUndefined();

    await expect(
      resolveInitialSession({
        sessionService: { getSessions: vi.fn(), getSession: vi.fn() },
        doc: null,
        workbench: null,
      }),
    ).resolves.toBeUndefined();
  });

  test("prioritizes a pinned session and defers URL handoff cleanup to the caller", async () => {
    const pinned = {
      sessionId: "pinned-session",
      pinned: true,
    } as CopilotChatHistoryFragment;
    const sessionService: SessionService = {
      getSessions: vi.fn().mockResolvedValueOnce([pinned]),
      getSession: vi.fn(),
    };
    const { workbench, updateQueryString } = makeWorkbench(
      "?sessionId=from-url",
    );

    const resolved = await resolveInitialSession({
      sessionService,
      doc: sampleDoc,
      workbench,
    });

    expect(resolved).toBe(pinned);
    expect(sessionService.getSession).not.toHaveBeenCalled();
    expect(updateQueryString).not.toHaveBeenCalled();

    consumeSessionIdFromUrl(workbench, "from-url");
    expect(updateQueryString).toHaveBeenCalledWith(
      { sessionId: undefined },
      { replace: true },
    );
  });

  test("resolves the URL handoff session and only consumes matching navigation state", async () => {
    const urlSession = {
      sessionId: "url-session",
      pinned: false,
    } as CopilotChatHistoryFragment;
    const sessionService: SessionService = {
      getSessions: vi.fn().mockResolvedValueOnce([]),
      getSession: vi.fn().mockResolvedValueOnce(urlSession),
    };
    const { workbench, updateQueryString } = makeWorkbench(
      "?sessionId=url-session",
    );

    const resolved = await resolveInitialSession({
      sessionService,
      doc: sampleDoc,
      workbench,
    });

    expect(resolved).toBe(urlSession);
    expect(sessionService.getSession).toHaveBeenCalledWith(
      sampleDoc.workspace.id,
      "url-session",
    );
    expect(updateQueryString).not.toHaveBeenCalled();

    workbench.location$.value.search = "?sessionId=other-session";
    consumeSessionIdFromUrl(workbench, "url-session");
    expect(updateQueryString).not.toHaveBeenCalled();

    workbench.location$.value.search = "?sessionId=url-session";
    consumeSessionIdFromUrl(workbench, "url-session");
    expect(updateQueryString).toHaveBeenCalledWith(
      { sessionId: undefined },
      { replace: true },
    );
  });

  test("falls back to the most recent document session when no pinned or URL session exists", async () => {
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
    const { workbench } = makeWorkbench("");

    const resolved = await resolveInitialSession({
      sessionService,
      doc: sampleDoc,
      workbench,
    });

    expect(resolved).toBe(docSession);
    expect(sessionService.getSessions).toHaveBeenCalledWith(
      sampleDoc.workspace.id,
      sampleDoc.id,
      { action: false, fork: false, limit: 1 },
    );
  });

  test("throws when a requested URL session does not exist and keeps the URL untouched", async () => {
    const sessionService: SessionService = {
      getSessions: vi.fn().mockResolvedValueOnce([]),
      getSession: vi.fn().mockResolvedValueOnce(null),
    };
    const { workbench, updateQueryString } =
      makeWorkbench("?sessionId=missing");

    await expect(
      resolveInitialSession({
        sessionService,
        doc: sampleDoc,
        workbench,
      }),
    ).rejects.toThrow("Requested conversation unavailable");
    expect(updateQueryString).not.toHaveBeenCalled();
  });
});
