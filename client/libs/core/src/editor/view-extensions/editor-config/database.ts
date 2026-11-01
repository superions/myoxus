import {
  createServerDatabaseSlashMenuItems,
  renderServerDatabaseBlock,
} from "@myoxus/core/modules/database/database-block-adapter";
import type { FrameworkProvider } from "@myoxus/infra";
import type { DatabaseReferenceBlockModel } from "@virgultum/block-database/reference-store";

/** Configure the thin editor shell without activating editor-local data UI. */
export function createDatabaseReferenceOptionsConfig(
  framework: FrameworkProvider,
) {
  return {
    renderServerDatabase: (model: DatabaseReferenceBlockModel) =>
      renderServerDatabaseBlock(framework, model),
    slashMenuItems: createServerDatabaseSlashMenuItems(framework),
  };
}
