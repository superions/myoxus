import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import type {
  GraphQLQuery,
  QueryOptions,
  QueryResponse,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import type { GraphQLError } from "graphql";
import { useCallback, useMemo } from "react";
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";
import useSWRImmutable from "swr/immutable";
import useSWRInfinite from "swr/infinite";

export type UseQueryConfig<Query extends GraphQLQuery = GraphQLQuery> = Omit<
  SWRConfiguration<
    QueryResponse<Query>,
    GraphQLError,
    (options: QueryOptions<Query>) => Promise<QueryResponse<Query>>
  >,
  "fetcher"
> & {
  suppressErrorNotification?: boolean;
};

/**
 * A `useSWR` wrapper for sending graphql queries
 *
 * @example
 *
 * ```ts
 * import { someQuery, someQueryWithNoVars } from '@myoxus/graphql'
 *
 * const swrResponse1 = useQuery({
 *   query: workspaceByIdQuery,
 *   variables: { id: '1' }
 * })
 *
 * const swrResponse2 = useQuery({
 *   query: someQueryWithNoVars
 * })
 * ```
 */
type useQueryFn = <Query extends GraphQLQuery>(
  options?: QueryOptions<Query>,
  config?: UseQueryConfig<Query>,
) => SWRResponse<
  QueryResponse<Query>,
  GraphQLError,
  {
    suspense: true;
  }
>;

const createUseQuery =
  (immutable: boolean): useQueryFn =>
  (options, config) => {
    const configWithSuspense: SWRConfiguration = useMemo(
      () => ({
        suspense: true,
        ...config,
      }),
      [config],
    );
    const graphqlService = useService(GraphQLService);

    const useSWRFn = immutable ? useSWRImmutable : useSWR;
    return useSWRFn(
      options ? () => ["cloud", options.query.id, options.variables] : null,
      options ? () => graphqlService.gql(options) : null,
      configWithSuspense,
    );
  };

export const useQuery = createUseQuery(false);
export const useQueryImmutable = createUseQuery(true);

export function useQueryInfinite<Query extends GraphQLQuery>(
  options: Omit<QueryOptions<Query>, "variables"> & {
    getVariables: (
      pageIndex: number,
      previousPageData: QueryResponse<Query>,
    ) => QueryOptions<Query>["variables"];
  },
  config?: Omit<
    SWRConfiguration<
      QueryResponse<Query>,
      GraphQLError | GraphQLError[],
      (options: QueryOptions<Query>) => Promise<QueryResponse<Query>>
    >,
    "fetcher"
  >,
) {
  const configWithSuspense: SWRConfiguration = useMemo(
    () => ({
      suspense: true,
      ...config,
    }),
    [config],
  );
  const graphqlService = useService(GraphQLService);

  const { data, setSize, size, error, mutate } = useSWRInfinite<
    QueryResponse<Query>,
    GraphQLError | GraphQLError[]
  >(
    (pageIndex: number, previousPageData: QueryResponse<Query>) => {
      // When getVariables returns null, SWR stops fetching (no more pages).
      const variables = options.getVariables(pageIndex, previousPageData);
      if (variables === null || variables === undefined) {
        return null;
      }
      return ["cloud", options.query.id, variables];
    },
    async ([_, __, variables]) => {
      const params = { ...options, variables } as QueryOptions<Query>;
      return graphqlService.gql(params);
    },
    configWithSuspense,
  );

  const loadingMore = size > 0 && data && !data[size - 1];

  // Pagination end detection: if the last fetched page returned null key
  // (getVariables returned null) or the data array is shorter than the
  // requested size, there are no more items to load.
  const hasMore = !(data && data.length > 0 && data.length < size);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) {
      return;
    }
    setSize((size) => size + 1).catch((err) => {
      console.error(err);
    });
  }, [loadingMore, hasMore, setSize]);
  return {
    data,
    error,
    loadingMore,
    loadMore,
    hasMore,
    retry: mutate,
  };
}
