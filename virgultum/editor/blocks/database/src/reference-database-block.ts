// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin editor host for a server-backed Database reference.

import { BlockComponent } from "@virgultum/std";
import { html, nothing } from "lit";

import { DatabaseReferenceConfigExtension } from "./reference-config";
import type { DatabaseReferenceBlockModel } from "./reference-store";

/**
 * Renders only the canonical server reference. Legacy columns, rows, cells and
 * views remain migration input and are deliberately never read here.
 */
export class DatabaseReferenceBlockComponent extends BlockComponent<DatabaseReferenceBlockModel> {
  override renderBlock() {
    const databaseId =
      typeof this.model.props.serverDatabaseId === "string"
        ? this.model.props.serverDatabaseId.trim()
        : undefined;
    const options = this.std.getOptional(
      DatabaseReferenceConfigExtension.identifier,
    );
    if (
      !options ||
      (!databaseId &&
        this.model.props.serverRowId === undefined &&
        this.model.props.serverWorkspaceId === undefined)
    )
      return nothing;

    return html`<div
      contenteditable="false"
      data-server-database-reference=${databaseId}
    >
      ${options.renderServerDatabase(this.model)}
    </div>`;
  }
}
