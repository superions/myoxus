// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  gqlFetcherFactory,
  type GraphQLQuery,
  type QueryOptions,
  type QueryResponse,
} from "@myoxus/graphql";
import type { GraphQLError } from "graphql";
import { useCallback, useMemo } from "react";
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";
import useSWRInfinite, { type SWRInfiniteConfiguration } from "swr/infinite";

import { adminFetch } from "./fetch-utils";

import { ADMIN_GRAPHQL_CACHE_NAMESPACE } from "./query-cache";

export { ADMIN_GRAPHQL_CACHE_NAMESPACE } from "./query-cache";

export const gqlFetcher = gqlFetcherFactory("/graphql", adminFetch);

type AdminQueryConfiguration<Query extends GraphQLQuery> = Omit<
  SWRConfiguration<QueryResponse<Query>, GraphQLError>,
  "fetcher"
>;

function serializeVariables(variables: unknown) {
  return variables === undefined ? "no-variables" : JSON.stringify(variables);
}

function useGraphQLResource<Query extends GraphQLQuery>(
  options: QueryOptions<Query> | undefined,
  configuration: AdminQueryConfiguration<Query> | undefined,
  immutable: boolean,
): SWRResponse<QueryResponse<Query>, GraphQLError> {
  const queryId = options?.query.id;
  const variablesSignature = serializeVariables(options?.variables);
  const request = useMemo(
    () => options,
    // Inline variables are common in Admin routes. Their serialized value,
    // rather than their object identity, owns request stability.
    // oxlint-disable-next-line react/exhaustive-deps
    [queryId, variablesSignature],
  );
  const cacheKey = useMemo(
    () =>
      request
        ? [ADMIN_GRAPHQL_CACHE_NAMESPACE, request.query.id, request.variables]
        : null,
    [request],
  );
  const load = useCallback(
    () => gqlFetcher(request as QueryOptions<Query>),
    [request],
  );

  return useSWR(cacheKey, request ? load : null, {
    suspense: false,
    // Undefined overrides erase inherited SWR defaults, including reconnect.
    ...(immutable
      ? {
          revalidateIfStale: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }
      : {}),
    ...configuration,
  });
}

export function useQuery<Query extends GraphQLQuery>(
  options?: QueryOptions<Query>,
  configuration?: AdminQueryConfiguration<Query>,
) {
  return useGraphQLResource(options, configuration, false);
}

export function useQueryImmutable<Query extends GraphQLQuery>(
  options?: QueryOptions<Query>,
  configuration?: AdminQueryConfiguration<Query>,
) {
  return useGraphQLResource(options, configuration, true);
}

type InfiniteQueryOptions<Query extends GraphQLQuery> = Omit<
  QueryOptions<Query>,
  "variables"
> & {
  getVariables: (
    pageIndex: number,
    previousPageData: QueryResponse<Query>,
  ) => QueryOptions<Query>["variables"];
};

type InfiniteQueryConfiguration<Query extends GraphQLQuery> = Omit<
  SWRInfiniteConfiguration<QueryResponse<Query>, GraphQLError | GraphQLError[]>,
  "fetcher"
>;

export function useQueryInfinite<Query extends GraphQLQuery>(
  options: InfiniteQueryOptions<Query>,
  configuration?: InfiniteQueryConfiguration<Query>,
) {
  const result = useSWRInfinite<
    QueryResponse<Query>,
    GraphQLError | GraphQLError[]
  >(
    (pageIndex, previousPageData) => {
      const variables = options.getVariables(
        pageIndex,
        previousPageData as unknown as QueryResponse<Query>,
      );
      return variables == null
        ? null
        : [ADMIN_GRAPHQL_CACHE_NAMESPACE, options.query.id, variables];
    },
    ([, , variables]) =>
      gqlFetcher({
        ...options,
        query: options.query,
        variables,
      } as QueryOptions<Query>),
    { suspense: false, ...configuration },
  );

  const loadingMore = result.size > 0 && !result.data?.[result.size - 1];
  const hasMore = !(
    result.data &&
    result.data.length > 0 &&
    result.data.length < result.size
  );
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    void result
      .setSize((current) => current + 1)
      .catch((error: unknown) => {
        console.error(error);
      });
  }, [hasMore, loadingMore, result]);

  return {
    data: result.data,
    error: result.error,
    loadingMore,
    loadMore,
    hasMore,
  };
}
