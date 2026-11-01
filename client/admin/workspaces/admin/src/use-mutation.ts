// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  GraphQLQuery,
  MutationOptions,
  QueryResponse,
  QueryVariables,
  RecursiveMaybeFields,
} from "@myoxus/graphql";
import type { GraphQLError } from "graphql";
import { useCallback } from "react";
import { type Key, useSWRConfig } from "swr";
import useSWRMutation, {
  type SWRMutationConfiguration,
  type SWRMutationResponse,
} from "swr/mutation";

import { ADMIN_GRAPHQL_CACHE_NAMESPACE, gqlFetcher } from "./use-query";

const ADMIN_GRAPHQL_MUTATION_NAMESPACE = "admin-graphql-mutation";

export function useMutation<Mutation extends GraphQLQuery, K extends Key = Key>(
  options: Omit<MutationOptions<Mutation>, "variables">,
  configuration?: Omit<
    SWRMutationConfiguration<
      QueryResponse<Mutation>,
      GraphQLError,
      K,
      QueryVariables<Mutation>
    >,
    "fetcher"
  >,
): SWRMutationResponse<
  QueryResponse<Mutation>,
  GraphQLError,
  K,
  QueryVariables<Mutation>
>;
export function useMutation(
  options: Omit<MutationOptions<GraphQLQuery>, "variables">,
  configuration?: SWRMutationConfiguration<any, any, any, any>,
) {
  return useSWRMutation(
    [ADMIN_GRAPHQL_MUTATION_NAMESPACE, options.mutation.id],
    (_key: unknown, { arg }: { arg: any }) =>
      gqlFetcher({
        ...options,
        query: options.mutation,
        variables: arg,
      }),
    configuration,
  );
}

export function useMutateQueryResource() {
  const { mutate } = useSWRConfig();

  return useCallback(
    <Query extends GraphQLQuery>(
      query: Query,
      matchesVariables: (
        variables: RecursiveMaybeFields<QueryVariables<Query>>,
      ) => boolean = () => true,
      options: { clearCachedData?: boolean } = {},
    ) => {
      const matchesKey = (key: Key) => {
        if (!Array.isArray(key)) return false;
        if (key[0] !== ADMIN_GRAPHQL_CACHE_NAMESPACE) return false;
        if (key[1] !== query.id) return false;
        return matchesVariables(key[2]);
      };
      // Revalidation alone leaves unmounted resources intact. A replaced
      // bundle must not briefly expose that revision when its tab reopens.
      return options.clearCachedData
        ? mutate(matchesKey, undefined, { revalidate: true })
        : mutate(matchesKey);
    },
    [mutate],
  );
}
