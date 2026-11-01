// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  DatabaseManagedSchemaReadiness,
  databaseTaskDestinationsQuery,
  type DatabaseTaskDestinationFragment,
  type QueryResponse,
  type DatabaseTasksInput,
  databaseTasksQuery,
} from "@myoxus/graphql";
import { useLiveData, useService } from "@myoxus/infra";
import { useMemo, useRef } from "react";
import useSWR from "swr";
import useSWRInfinite, {
  type SWRInfiniteConfiguration,
  type SWRInfiniteKeyLoader,
} from "swr/infinite";
import type { SWRFailureNotificationOptions } from "@myoxus/core/components/providers/swr-config-provider";

import { classifyDatabaseError } from "../route-state";
import { getDatabaseWorkspaceAvailability } from "../availability";
import { useTaskFreshness } from "./use-task-freshness";

export function useTaskIdentity() {
  const workspace = useService(WorkspaceService).workspace;
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const account = useLiveData(server?.account$);
  const availability = useMemo(
    () => getDatabaseWorkspaceAvailability(workspace),
    [workspace],
  );
  const identity =
    server && account
      ? JSON.stringify([server.id, server.baseUrl, account.id, workspace.id])
      : null;
  return useMemo(
    () => ({ workspace, server, account, availability, identity }),
    [workspace, server, account, availability, identity],
  );
}

export function workspaceTasksKey(
  owner: ReturnType<typeof useTaskIdentity>,
  input: DatabaseTasksInput,
  first: number,
  after?: string,
) {
  return owner.availability.status === "available" &&
    owner.server &&
    owner.account
    ? ([
        "database-tasks",
        owner.identity,
        {
          workspaceId: owner.workspace.id,
          input,
          first,
          after,
        },
      ] as const)
    : null;
}

export function fetchWorkspaceTasks(
  owner: ReturnType<typeof useTaskIdentity>,
  variables: NonNullable<ReturnType<typeof workspaceTasksKey>>[2],
) {
  return owner.server!.gql({ query: databaseTasksQuery, variables });
}

/** Shared bounded Task read for the cockpit and Home. Cache identity includes
 * server/account/workspace, so changing accounts cannot reuse Mine or ACL data.
 */
export function useWorkspaceTasks(
  input: DatabaseTasksInput,
  first: number,
  after?: string,
  onInvalidated?: () => void,
  enabled = true,
) {
  const owner = useTaskIdentity();
  const { workspace, availability, identity } = owner;
  const key = enabled ? workspaceTasksKey(owner, input, first, after) : null;
  const readIdentity = JSON.stringify(key);
  const lastRead = useRef<{ identity: string; error?: unknown } | undefined>(
    undefined,
  );
  const query = useSWR(
    key,
    async ([, , variables]) => {
      try {
        const result = await fetchWorkspaceTasks(owner, variables);
        lastRead.current = { identity: readIdentity };
        return result;
      } catch (error) {
        lastRead.current = { identity: readIdentity, error };
        throw error;
      }
    },
    {
      suspense: false,
      // This consumer presents failure locally, including Home section isolation.
      suppressErrorNotification: true,
      keepPreviousData: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
  // SWR's no-data mutate resolves cached data even when revalidation fails.
  // Mutation/freshness owners need the actual read outcome, not that resolution.
  const refresh = async () => {
    const result = await query.mutate();
    if (lastRead.current?.identity === readIdentity && lastRead.current.error)
      throw lastRead.current.error;
    return result;
  };
  const freshness = useTaskFreshness(
    owner,
    async () => {
      onInvalidated?.();
      await refresh();
    },
    undefined,
    enabled,
  );
  return {
    ...freshness,
    ...query,
    refresh,
    page: query.data?.workspace?.databaseTasks,
    // A joined room cannot make a failed canonical read healthy. SWR may resolve
    // a revalidation without throwing while retaining its error separately.
    live:
      freshness.live &&
      !query.error &&
      Boolean(query.data?.workspace?.databaseTasks),
    availability,
    identity,
    workspaceId: workspace.id,
  };
}

export type TaskDestination = DatabaseTaskDestinationFragment & {
  id: string;
  workspaceTasks: boolean;
};

type DestinationsResponse = QueryResponse<typeof databaseTaskDestinationsQuery>;
type DestinationsKeyLoader = SWRInfiniteKeyLoader<
  DestinationsResponse,
  readonly [string, string | null, number, string | null] | null
>;
const destinationReadOptions: SWRInfiniteConfiguration<
  DestinationsResponse,
  Error
> &
  SWRFailureNotificationOptions = {
  suspense: false,
  keepPreviousData: false,
  suppressErrorNotification: true,
  persistSize: false,
};

/** The canonical default is independent of Project pagination. A failed read
 * never initializes a destination or borrows another identity's cached choices.
 */
export function useTaskDestinations() {
  const { workspace, server, account, availability, identity } =
    useTaskIdentity();
  const query = useSWRInfinite<
    DestinationsResponse,
    Error,
    DestinationsKeyLoader
  >(
    (index, previous) => {
      const after = index
        ? (previous?.workspace?.databaseTaskDestinations.nextCursor ?? null)
        : null;
      if (
        availability.status !== "available" ||
        !server ||
        !account ||
        (index > 0 && !after)
      )
        return null;
      return ["database-task-destinations", identity, index, after];
    },
    ([, , , after]) =>
      server!.gql({
        query: databaseTaskDestinationsQuery,
        variables: {
          workspaceId: workspace.id,
          first: 100,
          after: after ?? undefined,
        },
      }),
    destinationReadOptions,
  );
  const denied =
    query.error &&
    ["forbidden", "missing"].includes(classifyDatabaseError(query.error));
  const pages = !denied
    ? (query.data
        ?.map((page) => page.workspace?.databaseTaskDestinations)
        .filter((page) => Boolean(page)) ?? [])
    : [];
  const defaultDestination = pages[0]?.defaultDestination ?? null;
  const byId = new Map<string, TaskDestination>();
  for (const page of pages) {
    for (const destination of page?.projects ?? [])
      byId.set(destination.databaseId, {
        ...destination,
        id: destination.databaseId,
        workspaceTasks: false,
      });
  }
  if (defaultDestination) byId.delete(defaultDestination.databaseId);
  const projects = [...byId.values()];
  const destinations: TaskDestination[] = [
    ...(defaultDestination
      ? [
          {
            ...defaultDestination,
            id: defaultDestination.databaseId,
            workspaceTasks: true,
          },
        ]
      : []),
    ...projects,
  ];
  const nextCursor = pages.at(-1)?.nextCursor;
  return {
    ...query,
    defaultDestination,
    destinationError: denied || (!pages.length && query.error),
    projects,
    destinations,
    readyDestinations: destinations.filter(
      (destination) =>
        destination.managedSchema.readiness ===
        DatabaseManagedSchemaReadiness.Ready,
    ),
    unavailableProjects: pages.flatMap(
      (page) => page?.unavailableProjects ?? [],
    ),
    coverageComplete: Boolean(
      pages.length &&
      pages.at(-1)?.coverageComplete &&
      !nextCursor &&
      defaultDestination?.managedSchema.readiness ===
        DatabaseManagedSchemaReadiness.Ready &&
      pages.every((page) => !page?.unavailableProjects.length),
    ),
    nextCursor,
    loadMore: () => query.setSize(query.size + 1),
    isLoadingMore: query.isValidating && Boolean(query.data?.length),
  };
}
