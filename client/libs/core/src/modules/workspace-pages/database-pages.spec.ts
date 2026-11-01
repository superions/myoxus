// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DatabasePageIdentityFragment,
  DatabaseProfileKind,
} from "@myoxus/graphql";
import { describe, expect, test, vi } from "vitest";

import {
  DatabasePageLoadError,
  loadDatabasePages,
} from "./database-page-loader";

function databaseSummary(id: string): DatabasePageIdentityFragment {
  return {
    createdAt: "2026-07-01T10:00:00.000Z",
    deletedAt: null,
    description: `Overview ${id}`,
    editRevision: 1,
    id,
    profileKind: DatabaseProfileKind.Generic,
    systemRole: null,
    title: `Database ${id}`,
    updatedAt: "2026-07-02T10:00:00.000Z",
  };
}

describe("Database Page inventory loader", () => {
  test("loads every page, follows short-page termination and de-duplicates IDs", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      databaseSummary(`database-${index}`),
    );
    const second = [
      databaseSummary("database-99"),
      ...Array.from({ length: 99 }, (_, index) =>
        databaseSummary(`database-${index + 100}`),
      ),
    ];
    const third = [
      databaseSummary("database-198"),
      ...Array.from({ length: 5 }, (_, index) =>
        databaseSummary(`database-${index + 199}`),
      ),
    ];
    const pages = new Map([
      [0, first],
      [100, second],
      [200, third],
    ]);
    const fetchPage = vi.fn(async (offset: number) => pages.get(offset) ?? []);

    const result = await loadDatabasePages({ fetchPage });

    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([
      0, 100, 200,
    ]);
    expect(result).toHaveLength(204);
    expect(new Set(result.map((record) => record.id)).size).toBe(204);
    expect(result.at(-1)?.key).toBe("database:database-203");
  });

  test("retains completed pages and resumes a failed later page at its exact offset", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      databaseSummary(`database-${index}`),
    );
    const failedFetch = vi.fn(async (offset: number) => {
      if (offset === 0) return first;
      throw new Error("later page unavailable");
    });

    let failure: DatabasePageLoadError | undefined;
    try {
      await loadDatabasePages({ fetchPage: failedFetch });
    } catch (error) {
      failure = error as DatabasePageLoadError;
    }

    expect(failure).toBeInstanceOf(DatabasePageLoadError);
    expect(failure?.failedOffset).toBe(100);
    expect(failure?.records).toHaveLength(100);

    const retryFetch = vi.fn(async (offset: number) => [
      databaseSummary(`database-${offset}`),
      databaseSummary(`database-${offset + 1}`),
    ]);
    const retried = await loadDatabasePages({
      existingRecords: failure?.records,
      fetchPage: retryFetch,
      startOffset: failure?.failedOffset,
    });

    expect(retryFetch).toHaveBeenCalledExactlyOnceWith(100, 100);
    expect(retried).toHaveLength(102);
    expect(new Set(retried.map((record) => record.id)).size).toBe(102);
  });

  test("ignores a completed response after its workspace generation becomes stale", async () => {
    let current = true;
    const result = await loadDatabasePages({
      isCurrent: () => current,
      fetchPage: async () => {
        current = false;
        return [databaseSummary("stale-database")];
      },
    });

    expect(result).toEqual([]);
  });
});
