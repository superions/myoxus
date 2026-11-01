// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseTaskDestinationFragment } from "@myoxus/graphql";

/** Consume only the caller's authorized ready projection. An explicit single
 * Project cannot silently turn into a Workspace Tasks command while loading. */
export function taskAssistanceDestination<
  T extends Pick<DatabaseTaskDestinationFragment, "databaseId" | "title">,
>(
  projectIds: readonly string[],
  defaultDatabaseId: string | undefined,
  ready: readonly T[],
): T | undefined {
  const id = projectIds.length === 1 ? projectIds[0] : defaultDatabaseId;
  return id
    ? ready.find((destination) => destination.databaseId === id)
    : undefined;
}
