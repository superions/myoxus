import {
  createServerDatabaseSlashMenuItems,
  renderServerDatabaseBlock,
} from "@myoxus/core/modules/database/database-block-adapter";
import type { FrameworkProvider } from "@myoxus/infra";
import type { DatabaseReferenceBlockModel } from "@virgultum/editor/blocks/database/reference-store";

/** Configure the thin editor shell without activating editor-local data UI. */
export function createDatabaseReferenceOptionsConfig(
  framework: FrameworkProvider,
) {
  return {
    renderServerDatabase: (
      anchor: HTMLElement,
      model: DatabaseReferenceBlockModel,
    ) => renderServerDatabaseBlock(framework, anchor, model),
    slashMenuItems: createServerDatabaseSlashMenuItems(framework),
  };
}
