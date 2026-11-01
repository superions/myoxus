// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GraphQLService } from "@myoxus/core/modules/server";
import {
  type DatabaseRowGroupSummaryFragment,
  type DatabaseRowGroupsQuery,
  databaseRowGroupsQuery,
  type DatabaseRowsQuery,
  databaseRowsQuery,
  type DatabaseRowsQueryVariables,
} from "@myoxus/graphql";

export type DatabaseRowsConnection = NonNullable<
  DatabaseRowsQuery["workspace"]
>["databaseRows"];

export type DatabaseScheduleWindowConnection = DatabaseRowsConnection & {
  groups?: DatabaseRowGroupSummaryFragment[];
};

type ScheduleWindowRowsVariables = Omit<
  DatabaseRowsQueryVariables,
  "after" | "first" | "offset"
>;

/** Publish complete Rows and their matching catalog as one abortable snapshot. */
export async function loadScheduleWindowRows({
  graphqlService,
  pageSize,
  signal,
  variables,
  grouped = false,
  locale,
}: {
  graphqlService: Pick<GraphQLService, "gql">;
  pageSize: number;
  signal: AbortSignal;
  variables: ScheduleWindowRowsVariables;
  grouped?: boolean;
  locale?: string;
}): Promise<DatabaseScheduleWindowConnection> {
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  try {
    const [connection, groups] = await Promise.all([
      loadRowsPages({
        graphqlService,
        pageSize,
        signal: requestSignal,
        variables,
      }),
      grouped
        ? (async () => {
            if (!variables.viewId)
              throw new Error("Grouped schedule requires a saved View.");
            const response: DatabaseRowGroupsQuery = await graphqlService.gql({
              query: databaseRowGroupsQuery,
              variables: {
                databaseId: variables.databaseId,
                workspaceId: variables.workspaceId,
                viewId: variables.viewId,
                search: variables.search,
                scheduleWindow: variables.scheduleWindow,
                locale,
              },
              signal: requestSignal,
            });
            if (!response.workspace)
              throw new Error("Database schedule groups are unavailable.");
            return response.workspace.databaseRowGroups;
          })()
        : undefined,
    ]);
    if (requestSignal.aborted) throw requestSignal.reason;
    return { ...connection, groups };
  } catch (error) {
    // A failed catalog must stop pagination too; no orphan request may complete
    // an apparently valid half-snapshot after the consumer rejected this demand.
    controller.abort(error);
    throw error;
  }
}

/**
 * Completes one server-filtered temporal window through stable Row cursors.
 * Workbench and Embed share this path so neither can silently truncate a
 * Calendar, Timeline or Gantt view at the first page.
 */
async function loadRowsPages({
  graphqlService,
  pageSize,
  signal,
  variables,
}: {
  graphqlService: Pick<GraphQLService, "gql">;
  pageSize: number;
  signal: AbortSignal;
  variables: ScheduleWindowRowsVariables;
}): Promise<DatabaseRowsConnection> {
  const rows: DatabaseRowsConnection["rows"] = [];
  let after: string | null = null;
  let totalCount = 0;

  while (!signal.aborted) {
    const response: DatabaseRowsQuery = await graphqlService.gql({
      query: databaseRowsQuery,
      variables: {
        ...variables,
        after,
        first: pageSize,
        offset: null,
      },
      signal,
    });
    const connection: DatabaseRowsConnection | undefined =
      response.workspace?.databaseRows;
    if (!connection) {
      throw new Error("Database schedule rows are unavailable.");
    }
    totalCount = connection.totalCount;
    rows.push(...connection.rows);

    if (connection.rows.length < pageSize) {
      return { rows, totalCount, endCursor: connection.endCursor };
    }

    const nextCursor: string | null = connection.endCursor;
    if (!nextCursor || nextCursor === after) {
      throw new Error(
        "Database schedule pagination returned no forward cursor.",
      );
    }
    after = nextCursor;
  }

  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
