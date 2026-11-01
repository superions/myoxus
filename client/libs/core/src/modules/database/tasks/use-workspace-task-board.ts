// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  databaseTasksQuery,
  type DatabaseTasksInput,
  type QueryResponse,
} from "@myoxus/graphql";
import { useEffect, useRef } from "react";
import useSWRInfinite, {
  type SWRInfiniteConfiguration,
  type SWRInfiniteKeyLoader,
} from "swr/infinite";
import type { SWRFailureNotificationOptions } from "@myoxus/core/components/providers/swr-config-provider";

import { classifyDatabaseError } from "../route-state";
import { useTaskFreshness } from "./use-task-freshness";
import {
  fetchWorkspaceTasks,
  useTaskIdentity,
  workspaceTasksKey,
} from "./use-workspace-tasks";

type Response = QueryResponse<typeof databaseTasksQuery>;
export type WorkspaceTaskPage = NonNullable<
  Response["workspace"]
>["databaseTasks"];
type KeyLoader = SWRInfiniteKeyLoader<
  Response,
  ReturnType<typeof workspaceTasksKey>
>;
const options: SWRInfiniteConfiguration<Response, Error> &
  SWRFailureNotificationOptions = {
  suspense: false,
  suppressErrorNotification: true,
  keepPreviousData: false,
  persistSize: false,
  parallel: false,
  revalidateAll: true,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
};

/** One cursor chain, not one query per column. Revalidation follows freshly read
 * cursors in order so edits cannot splice an old later page into a new first page.
 */
export function useWorkspaceTaskBoard(
  input: DatabaseTasksInput,
  enabled = true,
) {
  const owner = useTaskIdentity();
  const identity = JSON.stringify([owner.identity, input]);
  const lastRead = useRef<{ identity: string; error?: unknown } | undefined>(
    undefined,
  );
  const query = useSWRInfinite<Response, Error, KeyLoader>(
    (index, previous: Response | null) => {
      const after = previous?.workspace?.databaseTasks.nextCursor ?? undefined;
      if (!enabled || (index > 0 && !after)) return null;
      return workspaceTasksKey(owner, input, 20, after);
    },
    async ([, , variables]) => {
      try {
        const result = await fetchWorkspaceTasks(owner, variables);
        lastRead.current = { identity };
        return result;
      } catch (error) {
        lastRead.current = { identity, error };
        throw error;
      }
    },
    options,
  );
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    void query.setSize(1);
  }, [identity, query.setSize]);

  const recoveredError = useRef<unknown>(undefined);
  useEffect(() => {
    const extensions = (
      query.error as {
        extensions?: { code?: string; data?: { code?: string } };
      }
    )?.extensions;
    if (
      !enabled ||
      !query.error ||
      recoveredError.current === query.error ||
      (extensions?.code ?? extensions?.data?.code) !==
        "MIX_DATABASE_QUERY_INVALID"
    )
      return;
    recoveredError.current = query.error;
    // Drop the rejected continuation, never retry it or replay the originating write.
    void (async () => {
      await query.setSize(1);
      await query.mutate();
    })().catch(() => {
      /* The canonical read retains its own error/retry state. */
    });
  }, [enabled, query.error, query.setSize, query.mutate]);

  const refresh = async () => {
    const result = await query.mutate();
    if (lastRead.current?.identity === identity && lastRead.current.error)
      throw lastRead.current.error;
    return result;
  };
  const freshness = useTaskFreshness(owner, refresh, undefined, enabled);
  const denied =
    query.error &&
    ["forbidden", "missing"].includes(classifyDatabaseError(query.error));
  const pages =
    enabled && !denied
      ? (query.data?.flatMap((response) =>
          response.workspace ? [response.workspace.databaseTasks] : [],
        ) ?? [])
      : [];
  const rows = new Map<string, WorkspaceTaskPage["rows"][number]>();
  for (const page of pages)
    for (const row of page.rows) {
      const key = JSON.stringify([row.databaseId, row.rowId]);
      if (!rows.has(key)) rows.set(key, row);
    }
  const first = pages[0];
  const page = first
    ? {
        ...first,
        rows: [...rows.values()],
        nextCursor: pages.at(-1)?.nextCursor ?? null,
      }
    : undefined;
  return {
    ...query,
    refresh,
    ...freshness,
    live: freshness.live && !query.error && Boolean(page),
    page,
    loaded: rows.size,
    total: first?.totalCount ?? 0,
    identity: owner.identity,
    queryIdentity: identity,
    availability: owner.availability,
    workspaceId: owner.workspace.id,
    loadMore: () =>
      !query.isValidating && page?.nextCursor
        ? query.setSize(query.size + 1)
        : Promise.resolve(undefined),
    retry: () => query.mutate(),
    isLoadingMore: query.isValidating && Boolean(page),
  };
}
