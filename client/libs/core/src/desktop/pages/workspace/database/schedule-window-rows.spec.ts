// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseViewKind } from "@myoxus/graphql";
import { describe, expect, test, vi } from "vitest";

import { loadScheduleWindowRows } from "./schedule-window-rows";

const variables = {
  databaseId: "database-1",
  filter: null,
  filterTree: null,
  scheduleWindow: {
    end: "2026-07-31T23:59:59.999Z",
    fieldId: "field-date",
    start: "2026-07-01T00:00:00.000Z",
  },
  search: "release",
  sort: null,
  viewId: "view-timeline",
  workspaceId: "workspace-1",
};

function row(id: number) {
  return { row: { id: `row-${id}` }, redacted: false };
}

describe("loadScheduleWindowRows", () => {
  test("loads every visible-window page through each page's own cursor", async () => {
    const gql = vi
      .fn()
      .mockResolvedValueOnce({
        workspace: {
          databaseRows: {
            endCursor: "cursor-50",
            rows: Array.from({ length: 50 }, (_, index) => row(index)),
            totalCount: 121,
          },
        },
      })
      .mockResolvedValueOnce({
        workspace: {
          databaseRows: {
            endCursor: "cursor-100",
            rows: Array.from({ length: 50 }, (_, index) => row(index + 50)),
            totalCount: 121,
          },
        },
      })
      .mockResolvedValueOnce({
        workspace: {
          databaseRows: {
            endCursor: "cursor-121",
            rows: Array.from({ length: 21 }, (_, index) => row(index + 100)),
            totalCount: 121,
          },
        },
      });

    const result = await loadScheduleWindowRows({
      graphqlService: { gql } as never,
      pageSize: 50,
      signal: new AbortController().signal,
      variables,
    });

    expect(result.rows).toHaveLength(121);
    expect(result.totalCount).toBe(121);
    expect(gql).toHaveBeenCalledTimes(3);
    expect(gql.mock.calls.map(([request]) => request.variables.after)).toEqual([
      null,
      "cursor-50",
      "cursor-100",
    ]);
    for (const [request] of gql.mock.calls) {
      expect(request.variables).toMatchObject({
        first: 50,
        offset: null,
        scheduleWindow: variables.scheduleWindow,
        search: "release",
        viewId: "view-timeline",
      });
    }
  });

  test("stops a superseded page chain before it can request another page", async () => {
    const controller = new AbortController();
    const gql = vi.fn(async () => {
      controller.abort();
      return {
        workspace: {
          databaseRows: {
            endCursor: "cursor-50",
            rows: Array.from({ length: 50 }, (_, index) => row(index)),
            totalCount: 100,
          },
        },
      };
    });

    await expect(
      loadScheduleWindowRows({
        graphqlService: { gql } as never,
        pageSize: 50,
        signal: controller.signal,
        variables,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(gql).toHaveBeenCalledOnce();
  });

  test("fails closed when a full page has no advancing cursor", async () => {
    const gql = vi.fn().mockResolvedValue({
      workspace: {
        databaseRows: {
          endCursor: null,
          rows: Array.from({ length: 50 }, (_, index) => row(index)),
          totalCount: 100,
        },
      },
    });

    await expect(
      loadScheduleWindowRows({
        graphqlService: { gql } as never,
        pageSize: 50,
        signal: new AbortController().signal,
        variables: { ...variables, viewId: DatabaseViewKind.Timeline },
      }),
    ).rejects.toThrow("no forward cursor");
  });
});
