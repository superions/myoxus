// SPDX-License-Identifier: AGPL-3.0-or-later

import type { useMutateQueryResource } from "@myoxus/core/components/hooks/use-mutation";
import {
  databaseRowQuery,
  databaseRowsQuery,
  databaseRowTemplatesQuery,
  databaseSchemaQuery,
  databasesQuery,
  databaseViewQuery,
  databaseViewsQuery,
} from "@myoxus/graphql";
import { describe, expect, test, vi } from "vitest";

import { invalidateDatabaseChangeQueries } from "./change-invalidation";

type RevalidateQueryResource = ReturnType<typeof useMutateQueryResource>;

function setup() {
  const revalidate = vi.fn(async (..._args: unknown[]) => undefined);
  const refreshScheduleRows = vi.fn();
  const invalidate = (
    reason?: Parameters<typeof invalidateDatabaseChangeQueries>[0]["reason"],
  ) =>
    invalidateDatabaseChangeQueries({
      databaseId: "database-1",
      reason,
      refreshScheduleRows,
      revalidate: revalidate as unknown as RevalidateQueryResource,
      workspaceId: "workspace-1",
    });
  return { invalidate, refreshScheduleRows, revalidate };
}

function queryFamilies(revalidate: ReturnType<typeof vi.fn>) {
  return revalidate.mock.calls.map(([query]) => query);
}

describe("Database page change invalidation", () => {
  test("refreshes Rows, the affected linked detail, and schedule data for a Cell edit", async () => {
    const { invalidate, refreshScheduleRows, revalidate } = setup();

    await invalidate({
      kind: "cell_updated",
      target: { fieldId: "field-1", rowId: "row-1" },
    });

    expect(queryFamilies(revalidate)).toEqual([
      databaseRowsQuery,
      databaseRowQuery,
    ]);
    expect(refreshScheduleRows).toHaveBeenCalledOnce();
    const detailFilter = revalidate.mock.calls[1]?.[1] as (
      variables: Record<string, string>,
    ) => boolean;
    expect(
      detailFilter({
        databaseId: "database-1",
        rowId: "row-1",
        workspaceId: "workspace-1",
      }),
    ).toBe(true);
    expect(
      detailFilter({
        databaseId: "database-1",
        rowId: "row-2",
        workspaceId: "workspace-1",
      }),
    ).toBe(false);
  });

  test("refreshes structural and template families without broad fallback", async () => {
    const fieldChange = setup();
    await fieldChange.invalidate({ kind: "field_updated" });
    expect(queryFamilies(fieldChange.revalidate)).toEqual([
      databaseSchemaQuery,
      databaseRowsQuery,
      databaseRowQuery,
    ]);

    const templateChange = setup();
    await templateChange.invalidate({ kind: "row_template_updated" });
    expect(queryFamilies(templateChange.revalidate)).toEqual([
      databaseRowTemplatesQuery,
    ]);
  });

  test("keeps full refresh for unknown events and explicit conflict reloads", async () => {
    const expected = [
      databaseSchemaQuery,
      databaseViewsQuery,
      databaseViewQuery,
      databaseRowsQuery,
      databaseRowQuery,
      databaseRowTemplatesQuery,
      databasesQuery,
    ];
    const unknown = setup();
    await unknown.invalidate({ kind: "future_server_event" });
    expect(queryFamilies(unknown.revalidate)).toEqual(expected);

    const conflict = setup();
    await conflict.invalidate();
    expect(queryFamilies(conflict.revalidate)).toEqual(expected);
  });
});
