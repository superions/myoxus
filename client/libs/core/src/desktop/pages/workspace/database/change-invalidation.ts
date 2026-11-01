// SPDX-License-Identifier: AGPL-3.0-or-later

import type { useMutateQueryResource } from "@myoxus/core/components/hooks/use-mutation";
import {
  type DatabaseChangeInput,
  databaseChangeImpact,
} from "@myoxus/core/modules/database/shared/change-invalidation";
import {
  databaseRowQuery,
  databaseRowsQuery,
  databaseRowTemplatesQuery,
  databaseSchemaQuery,
  databasesQuery,
  databaseViewQuery,
  databaseViewsQuery,
} from "@myoxus/graphql";

type RevalidateQueryResource = ReturnType<typeof useMutateQueryResource>;

/** Executes route-owned query invalidation for the shared change impact. */
export async function invalidateDatabaseChangeQueries({
  databaseId,
  reason,
  refreshScheduleRows,
  revalidate,
  workspaceId,
}: {
  databaseId: string;
  reason?: DatabaseChangeInput;
  refreshScheduleRows: () => Promise<void> | void;
  revalidate: RevalidateQueryResource;
  workspaceId: string;
}) {
  const impact = databaseChangeImpact(reason ?? { kind: "full_reload" });

  const currentDatabase = (variables: {
    workspaceId: string;
    databaseId: string;
  }) =>
    variables.workspaceId === workspaceId &&
    variables.databaseId === databaseId;
  const requests: Promise<unknown>[] = [];
  // Mutation consumers finish only after the authoritative temporal page has
  // arrived, so Saving and focus recovery cannot precede their own readback.
  if (impact.scheduleRows)
    requests.push(Promise.resolve(refreshScheduleRows()));
  if (impact.schema) {
    requests.push(revalidate(databaseSchemaQuery, currentDatabase));
  }
  if (impact.viewSummaries) {
    requests.push(revalidate(databaseViewsQuery, currentDatabase));
  }
  if (impact.activeView) {
    requests.push(
      revalidate(
        databaseViewQuery,
        (variables) =>
          currentDatabase(variables) &&
          (!reason?.target?.viewId ||
            variables.viewId === reason.target.viewId),
      ),
    );
  }
  if (impact.rows) {
    requests.push(revalidate(databaseRowsQuery, currentDatabase));
  }
  if (impact.linkedRow) {
    requests.push(
      revalidate(
        databaseRowQuery,
        (variables) =>
          currentDatabase(variables) &&
          (!reason?.target?.rowId || variables.rowId === reason.target.rowId),
      ),
    );
  }
  if (impact.rowTemplates) {
    requests.push(revalidate(databaseRowTemplatesQuery, currentDatabase));
  }
  if (impact.inventory) {
    requests.push(
      revalidate(
        databasesQuery,
        (variables) => variables.workspaceId === workspaceId,
      ),
    );
  }
  await Promise.all(requests);
}
