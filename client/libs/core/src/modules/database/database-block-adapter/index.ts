// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public boundary for the reference-only server Database embed.
import type { FrameworkProvider } from "@myoxus/infra";
import type { DatabaseReferenceBlockModel } from "@virgultum/editor/blocks/database/reference-store";
import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import { defineDatabaseEmbedElement } from "./server-database-block";
import { resolveTaskReferenceScope } from "./task-reference-scope";
export { defineDatabaseEmbedElement };
export function renderServerDatabaseBlock(
  framework: FrameworkProvider,
  anchor: HTMLElement,
  model: DatabaseReferenceBlockModel,
) {
  defineDatabaseEmbedElement();
  const { id, flavour } = framework.get(WorkspaceService).workspace;
  const embed =
    anchor.querySelector("myoxus-database-embed") ??
    anchor.ownerDocument.createElement("myoxus-database-embed");
  if (!embed.parentNode) {
    embed.framework = framework;
    embed.setAttribute("workspace-id", id);
    embed.setAttribute("workspace-flavour", flavour);
  }
  const scope = resolveTaskReferenceScope(model.props, id);
  const attributes = {
    "database-id": model.props.serverDatabaseId ?? "",
    "view-id": model.props.serverViewId ?? "",
    "reference-mode": scope.kind,
    "row-id": scope.kind === "task" ? scope.rowId : "",
  };
  for (const [key, value] of Object.entries(attributes)) {
    if (embed.getAttribute(key) !== value) embed.setAttribute(key, value);
  }
  embed.toggleAttribute("readonly", model.store.readonly$.value);
  if (!embed.parentNode) anchor.append(embed);
}
export {
  createServerDatabaseSlashMenuItems,
  insertServerDatabaseBlockReference,
  type ServerDatabaseBlockReference,
} from "./server-database-slash-menu";
