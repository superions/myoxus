// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public boundary for the reference-only server Database embed.
import type { FrameworkProvider } from "@myoxus/infra";
import type { DatabaseReferenceBlockModel } from "@virgultum/editor/blocks/database/reference-store";
import { html } from "lit";
import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import { defineDatabaseEmbedElement } from "./server-database-block";
import { resolveTaskReferenceScope } from "./task-reference-scope";
export { defineDatabaseEmbedElement };
export function renderServerDatabaseBlock(
  framework: FrameworkProvider,
  model: DatabaseReferenceBlockModel,
) {
  defineDatabaseEmbedElement();
  const { id, flavour } = framework.get(WorkspaceService).workspace;
  const scope = resolveTaskReferenceScope(model.props, id);
  return html`<myoxus-database-embed
    .framework=${framework}
    ?readonly=${model.store.readonly}
    database-id=${model.props.serverDatabaseId ?? ""}
    reference-mode=${scope.kind}
    row-id=${scope.kind === "task" ? scope.rowId : ""}
    view-id=${model.props.serverViewId ?? ""}
    workspace-flavour=${flavour}
    workspace-id=${id}
  ></myoxus-database-embed>`;
}
export {
  createServerDatabaseSlashMenuItems,
  insertServerDatabaseBlockReference,
  type ServerDatabaseBlockReference,
} from "./server-database-slash-menu";
