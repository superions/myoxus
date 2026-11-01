import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import type {
  GraphQLQuery,
  MutationOptions,
  QueryResponse,
  QueryVariables,
  RecursiveMaybeFields,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import type { GraphQLError } from "graphql";
import { useMemo } from "react";
import { type Key, useSWRConfig } from "swr";
import useSWRMutation, {
  type SWRMutationConfiguration,
  type SWRMutationResponse,
} from "swr/mutation";

export type UseMutationConfig<
  Mutation extends GraphQLQuery = GraphQLQuery,
  K extends Key = Key,
> = Omit<
  SWRMutationConfiguration<
    QueryResponse<Mutation>,
    GraphQLError,
    K,
    QueryVariables<Mutation>
  >,
  "fetcher"
> & {
  /** Native SWR hook default; callers may still override it per trigger. */
  throwOnError?: boolean;
  /** The consuming control owns a complete, local error state. */
  suppressErrorNotification?: boolean;
};

/**
 * A useSWRMutation wrapper for sending graphql mutations
 *
 * @example
 *
 * ```ts
 * import { someMutation } from '@myoxus/graphql'
 *
 * const { trigger } = useMutation({
 *  mutation: someMutation,
 * })
 *
 * trigger({ name: 'John Doe' })
 */
export function useMutation<Mutation extends GraphQLQuery, K extends Key = Key>(
  options: Omit<MutationOptions<Mutation>, "variables">,
  config?: UseMutationConfig<Mutation, K>,
): SWRMutationResponse<
  QueryResponse<Mutation>,
  GraphQLError,
  K,
  QueryVariables<Mutation>
>;
export function useMutation(
  options: Omit<MutationOptions<GraphQLQuery>, "variables">,
  config?: any,
) {
  const graphqlService = useService(GraphQLService);
  return useSWRMutation(
    () => ["cloud", options.mutation.id],
    (_: unknown[], { arg }: { arg: any }) =>
      graphqlService.gql({
        ...options,
        query: options.mutation,
        variables: arg,
      }),
    config,
  );
}

// use this to revalidate all queries that match the filter
export const useMutateQueryResource = () => {
  const { mutate } = useSWRConfig();
  const revalidateResource = useMemo(
    () =>
      <Q extends GraphQLQuery>(
        query: Q,
        varsFilter: (
          vars: RecursiveMaybeFields<QueryVariables<Q>>,
        ) => boolean = (_vars) => true,
      ) => {
        return mutate((key) => {
          const res =
            Array.isArray(key) &&
            key[0] === "cloud" &&
            key[1] === query.id &&
            varsFilter(key[2]);
          if (res) {
            console.debug("revalidate resource", key);
          }
          return res;
        });
      },
    [mutate],
  );

  return revalidateResource;
};
