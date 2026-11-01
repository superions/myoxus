// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import {
  DatabaseTaskLifecycle,
  DatabaseTaskScope,
  databaseTasksQuery,
} from "@myoxus/graphql";

/** One bounded page per lifecycle; each continuation belongs to its own query.
 * Consumers own admission, cancellation and actor-scoped display lifetimes. */
export function readTaskCandidatePages({
  gql,
  workspaceId,
  databaseId,
  search,
  timeZone,
  after,
  signal,
}: {
  gql: GraphQLService["gql"];
  workspaceId: string;
  databaseId: string;
  search: string;
  timeZone: string;
  after?: (string | null)[];
  signal: AbortSignal;
}) {
  return Promise.all(
    [DatabaseTaskLifecycle.Open, DatabaseTaskLifecycle.Closed].map(
      async (lifecycle, index) => {
        if (after && !after[index]) return null;
        const response = await gql({
          query: databaseTasksQuery,
          variables: {
            workspaceId,
            input: {
              scope: DatabaseTaskScope.All,
              projectIds: [databaseId],
              lifecycle,
              search,
              timeZone,
            },
            first: 50,
            after: after?.[index] ?? undefined,
          },
          context: { signal },
        });
        const page = response.workspace?.databaseTasks;
        if (!page) throw new Error("Task candidates unavailable");
        return page;
      },
    ),
  );
}
