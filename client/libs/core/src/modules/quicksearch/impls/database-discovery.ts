import {
  type DatabaseSearchHit,
  databaseSearchQuery,
  databasesQuery,
} from "@myoxus/graphql";

import type { GraphQLService } from "../../server";

export interface DatabaseDiscoveryRecord {
  id: string;
  title: string;
  updatedAt: string;
}

export function databaseRoute(databaseId: string) {
  return `/databases/${encodeURIComponent(databaseId)}`;
}

export function databaseRowRoute(databaseId: string, rowId: string) {
  const search = new URLSearchParams({ rowId });
  return `${databaseRoute(databaseId)}?${search.toString()}`;
}

export async function findDatabases(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  {
    databaseIds,
    first,
    offset,
    search,
    signal,
  }: {
    databaseIds?: string[];
    first: number;
    offset?: number;
    search?: string;
    signal: AbortSignal;
  },
): Promise<DatabaseDiscoveryRecord[]> {
  const response = await graphqlService.gql({
    query: databasesQuery,
    variables: {
      workspaceId,
      first,
      ...(offset === undefined ? {} : { offset }),
      search,
      databaseIds,
    },
    context: { signal },
  });
  return (response.workspace?.databases ?? []).map((database) => ({
    id: database.id,
    title: database.title,
    updatedAt: database.updatedAt,
  }));
}

export async function findDatabaseRows(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  query: string,
  first: number,
  signal: AbortSignal,
  offset?: number,
): Promise<DatabaseSearchHit[]> {
  const response = await graphqlService.gql({
    query: databaseSearchQuery,
    variables: {
      workspaceId,
      filter: { first, query, ...(offset === undefined ? {} : { offset }) },
    },
    context: { signal },
  });
  return response.workspace?.databaseSearch ?? [];
}
