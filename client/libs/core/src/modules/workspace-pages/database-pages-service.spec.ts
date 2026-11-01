// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { DatabaseProfileKind } from "@myoxus/graphql";
import { createIdentifier, Framework } from "@myoxus/infra";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WorkspaceServerService } from "../server";
import type { WorkspaceService } from "../workspace";

import { DatabasePagesService } from "./database-pages-service";

function databaseSummary(id: string) {
  return {
    createdAt: "2026-07-15T06:00:00Z",
    deletedAt: null,
    description: "Visible overview",
    editRevision: 1,
    id,
    profileKind: DatabaseProfileKind.Generic,
    systemRole: null,
    title: `Database ${id}`,
    updatedAt: "2026-07-15T06:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const WorkspaceForTest = createIdentifier<WorkspaceService>(
  "WorkspaceForDatabasePagesTest",
);
const WorkspaceServerForTest = createIdentifier<WorkspaceServerService>(
  "WorkspaceServerForDatabasePagesTest",
);
const providers: Array<{ dispose(): void }> = [];
const gql = vi.fn();

function createService(graphql = gql) {
  const framework = new Framework();
  const testFramework = framework as any;
  testFramework.service(WorkspaceForTest, {
    workspace: { id: "workspace-1" },
  });
  testFramework.service(WorkspaceServerForTest, {
    server: { gql: graphql, config$: { value: null } },
  });
  framework.service(DatabasePagesService, [
    WorkspaceForTest,
    WorkspaceServerForTest,
  ]);
  const provider = framework.provider();
  providers.push(provider);
  return provider.get(DatabasePagesService);
}

beforeEach(() => gql.mockReset());
afterEach(() => providers.splice(0).forEach((provider) => provider.dispose()));

describe("DatabasePagesService", () => {
  test("shares concurrent demand and caches a confirmed empty result", async () => {
    const first = deferred<{
      workspace: { databasePageIdentities: never[] };
    }>();
    gql.mockReturnValueOnce(first.promise);
    const service = createService();

    const releaseFirst = service.acquire("active");
    const releaseSecond = service.acquire("active");
    expect(gql).toHaveBeenCalledTimes(1);
    first.resolve({ workspace: { databasePageIdentities: [] } });
    await first.promise;
    await vi.waitFor(() =>
      expect(service.state$("active").value.status).toBe("ready"),
    );

    releaseFirst();
    service.acquire("active");
    expect(gql).toHaveBeenCalledTimes(1);
    releaseSecond();
  });

  test("invalidates active and trashed projections from offset zero", async () => {
    gql.mockResolvedValue({
      workspace: {
        databasePageIdentities: [],
        trashedDatabasePageIdentities: [],
      },
    });
    const service = createService();
    service.acquire("active");
    service.acquire("trashed");
    await vi.waitFor(() => expect(gql).toHaveBeenCalledTimes(2));

    service.invalidate();
    await vi.waitFor(() => expect(gql).toHaveBeenCalledTimes(4));
    expect(gql.mock.calls.map(([request]) => request.variables.offset)).toEqual(
      [0, 0, 0, 0],
    );
  });

  test("keeps equal workspace IDs isolated across scoped server owners", async () => {
    const firstServerGql = vi.fn().mockResolvedValue({
      workspace: { databasePageIdentities: [] },
    });
    const secondServerGql = vi.fn().mockResolvedValue({
      workspace: { databasePageIdentities: [] },
    });
    const firstServer = createService(firstServerGql);
    const secondServer = createService(secondServerGql);
    firstServer.acquire("active");
    secondServer.acquire("active");
    await vi.waitFor(() => {
      expect(firstServerGql).toHaveBeenCalledTimes(1);
      expect(secondServerGql).toHaveBeenCalledTimes(1);
    });

    firstServer.invalidate();
    await vi.waitFor(() => expect(firstServerGql).toHaveBeenCalledTimes(2));
    expect(secondServerGql).toHaveBeenCalledTimes(1);
  });

  test("only aborts an active load after its last consumer releases demand", async () => {
    const pending = deferred<{
      workspace: { databasePageIdentities: never[] };
    }>();
    gql.mockReturnValue(pending.promise);
    const service = createService();
    const releaseFirst = service.acquire("active");
    const releaseSecond = service.acquire("active");
    const signal = gql.mock.calls[0]?.[0].context.signal as AbortSignal;

    releaseFirst();
    expect(signal.aborted).toBe(false);
    releaseSecond();
    expect(signal.aborted).toBe(true);
    pending.resolve({ workspace: { databasePageIdentities: [] } });
    await pending.promise;
  });

  test("retries a failed later page without duplicating confirmed records", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      databaseSummary(`database-${index}`),
    );
    gql
      .mockResolvedValueOnce({
        workspace: { databasePageIdentities: firstPage },
      })
      .mockRejectedValueOnce(new Error("later page unavailable"))
      .mockResolvedValueOnce({
        workspace: {
          databasePageIdentities: [databaseSummary("database-100")],
        },
      });
    const service = createService();
    service.acquire("active");
    await vi.waitFor(() =>
      expect(service.state$("active").value.status).toBe("error"),
    );
    expect(service.state$("active").value).toMatchObject({
      failedOffset: 100,
      records: { length: 100 },
    });

    service.retry("active");
    await vi.waitFor(() =>
      expect(service.state$("active").value.status).toBe("ready"),
    );
    expect(service.state$("active").value.records).toHaveLength(101);
    expect(gql.mock.calls.map(([request]) => request.variables.offset)).toEqual(
      [0, 100, 100],
    );
  });

  test("discards retained rows after access is denied", async () => {
    gql
      .mockResolvedValueOnce({
        workspace: { databasePageIdentities: [databaseSummary("database-1")] },
      })
      .mockRejectedValueOnce({
        status: 403,
        type: "FORBIDDEN",
        name: "FORBIDDEN",
        message: "Access denied",
      });
    const service = createService();
    service.acquire("active");
    await vi.waitFor(() =>
      expect(service.state$("active").value.status).toBe("ready"),
    );

    service.reload("active");
    await vi.waitFor(() =>
      expect(service.state$("active").value.status).toBe("error"),
    );
    expect(service.state$("active").value.records).toEqual([]);
  });

  test("ignores an obsolete generation after invalidation", async () => {
    const obsolete = deferred<{
      workspace: {
        databasePageIdentities: ReturnType<typeof databaseSummary>[];
      };
    }>();
    gql.mockReturnValueOnce(obsolete.promise).mockResolvedValueOnce({
      workspace: { databasePageIdentities: [databaseSummary("current")] },
    });
    const service = createService();
    service.acquire("active");
    service.invalidate();
    await vi.waitFor(() =>
      expect(service.state$("active").value.records[0]?.id).toBe("current"),
    );

    obsolete.resolve({
      workspace: { databasePageIdentities: [databaseSummary("obsolete")] },
    });
    await obsolete.promise;
    expect(service.state$("active").value.records[0]?.id).toBe("current");
  });
});
