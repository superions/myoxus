// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assistantPresentationQuery,
  type AssistantContext,
} from "@myoxus/graphql";
import useSWR from "swr";
import { useEffect, useRef } from "react";
import { classifyDatabaseError } from "../route-state";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";

/** Package discovery is readonly and scoped to the native actor/target. It
 * cannot authorize content or replace a pending native operation's recovery. */
export function useAssistantPresentation(
  context: AssistantContext,
  databaseId?: string,
  rowId?: string,
  nativeRevision?: string,
) {
  const owner = useTaskIdentity();
  const enabled =
    owner.availability.status === "available" &&
    Boolean(owner.identity && owner.server);
  const query = useSWR(
    enabled
      ? [
          "database-assistant-presentation",
          owner.identity,
          context,
          databaseId,
          rowId,
        ]
      : null,
    () =>
      owner.server!.gql({
        query: assistantPresentationQuery,
        variables: {
          workspaceId: owner.workspace.id,
          context,
          databaseId,
          rowId,
        },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const revision = useRef({
    identity: owner.identity,
    databaseId,
    rowId,
    nativeRevision,
  });
  const { mutate } = query;
  useEffect(() => {
    const previous = revision.current;
    revision.current = {
      identity: owner.identity,
      databaseId,
      rowId,
      nativeRevision,
    };
    if (
      enabled &&
      previous.identity === owner.identity &&
      previous.databaseId === databaseId &&
      previous.rowId === rowId &&
      previous.nativeRevision !== nativeRevision
    ) {
      // Presence groups are projected from canonical Row slots, so a native
      // content change must refresh composition without replacing input state.
      void mutate();
    }
  }, [enabled, owner.identity, databaseId, rowId, nativeRevision, mutate]);
  const invalidated = Boolean(
    query.error &&
    ["forbidden", "missing"].includes(classifyDatabaseError(query.error)),
  );
  const projection = !invalidated
    ? query.data?.workspace?.assistantPresentation
    : undefined;
  return {
    ...query,
    projection,
    invalidated,
    descriptor:
      projection && !projection.unavailableReason
        ? projection.descriptor
        : null,
    owner,
  };
}
