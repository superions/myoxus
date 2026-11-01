// SPDX-License-Identifier: AGPL-3.0-or-later

import { assistantPackagesQuery, type AssistantContext } from "@myoxus/graphql";
import useSWR from "swr";
import { classifyDatabaseError } from "../route-state";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";

/** Shared read-only package discovery for native commands outside the detail
 * body. All Row menus share one actor/context read; fields still use their
 * canonical managed bindings and native permission checks. */
export function useAssistantPackage(context: AssistantContext, enabled = true) {
  const owner = useTaskIdentity();
  const query = useSWR(
    enabled &&
      owner.identity &&
      owner.server &&
      owner.availability.status === "available"
      ? ["database-assistant-package", owner.identity, context]
      : null,
    () =>
      owner.server!.gql({
        query: assistantPackagesQuery,
        variables: { workspaceId: owner.workspace.id, context },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const invalidated = Boolean(
    query.error &&
    ["missing", "forbidden"].includes(classifyDatabaseError(query.error)),
  );
  return {
    ...query,
    descriptor:
      enabled && !invalidated
        ? query.data?.workspace?.assistantPackages.find((item) =>
            item.defaultFor.includes(context),
          )
        : undefined,
  };
}
