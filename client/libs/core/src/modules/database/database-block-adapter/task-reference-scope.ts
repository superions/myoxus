// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseReferenceBlockModel } from "@virgultum/block-database/reference-store";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An explicit scope is never repaired using the containing workspace. */
export function resolveTaskReferenceScope(
  props: Pick<
    DatabaseReferenceBlockModel["props"],
    | "serverWorkspaceId"
    | "serverDatabaseId"
    | "serverRowId"
    | "serverViewId"
    | "serverReferencePresentation"
    | "templateReference"
  >,
  containingWorkspaceId: string,
) {
  if (props.templateReference !== undefined)
    return { kind: "unavailable" as const };
  if (props.serverReferencePresentation !== undefined) {
    if (
      props.serverReferencePresentation !== "compact" ||
      props.serverWorkspaceId !== containingWorkspaceId ||
      ![props.serverWorkspaceId, props.serverDatabaseId].every(
        (value) => typeof value === "string" && uuid.test(value),
      ) ||
      (props.serverViewId !== undefined && props.serverViewId !== null)
    )
      return { kind: "unavailable" as const };
    if (props.serverRowId === undefined) return { kind: "container" as const };
  }
  if (props.serverRowId === undefined && props.serverWorkspaceId === undefined)
    return { kind: "database" as const };
  if (
    props.serverRowId === undefined &&
    props.serverWorkspaceId === containingWorkspaceId &&
    typeof props.serverDatabaseId === "string" &&
    uuid.test(props.serverWorkspaceId) &&
    uuid.test(props.serverDatabaseId)
  )
    return { kind: "database" as const };
  if (
    !props.serverWorkspaceId ||
    !props.serverRowId ||
    !props.serverDatabaseId ||
    props.serverWorkspaceId !== containingWorkspaceId ||
    ![props.serverWorkspaceId, props.serverDatabaseId, props.serverRowId].every(
      (value) => typeof value === "string" && uuid.test(value),
    ) ||
    (props.serverViewId !== undefined && props.serverViewId !== null)
  )
    return { kind: "unavailable" as const };
  return {
    kind: "task" as const,
    workspaceId: props.serverWorkspaceId,
    databaseId: props.serverDatabaseId,
    rowId: props.serverRowId,
  };
}
