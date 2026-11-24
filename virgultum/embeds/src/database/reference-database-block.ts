// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin editor host for a server-backed Database reference.

import { NativeContainerBlock } from "@virgultum/core/runtime";
import { DatabaseReferenceConfigExtension } from "./reference-config";
import type { DatabaseReferenceBlockModel } from "./reference-store";

/** Only canonical server addresses own a view. Historic local cells and
 * columns remain data for migration and never activate a local renderer. */
export class DatabaseReferenceBlockComponent extends NativeContainerBlock<DatabaseReferenceBlockModel> {
  protected readonly blockStyles = "";
  protected mountBody() {
    const options = this.std.getOptional(
      DatabaseReferenceConfigExtension.identifier,
    );
    if (!options) return null;
    const anchor = this.ownerDocument.createElement("div");
    anchor.contentEditable = "false";
    const refresh = () => {
      const raw = this.model.props.serverDatabaseId;
      const id = typeof raw === "string" ? raw.trim() : "";
      if (
        !id &&
        this.model.props.serverRowId === undefined &&
        this.model.props.serverWorkspaceId === undefined
      ) {
        anchor.replaceChildren();
        anchor.remove();
        return;
      }
      anchor.dataset.serverDatabaseReference = id;
      if (anchor.parentNode !== this) this.append(anchor);
      options.renderServerDatabase(anchor, this.model);
    };
    this.disposables.add(this.model.propsUpdated.subscribe(refresh));
    this.disposables.add(this.store.readonly$.subscribe(refresh));
    return null;
  }
}
