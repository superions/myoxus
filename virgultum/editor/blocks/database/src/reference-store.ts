// SPDX-License-Identifier: AGPL-3.0-or-later
//! Schema and static adapter registration for server-backed Database references.

import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import {
  DatabaseBlockModel,
  type DatabaseBlockProps,
  DatabaseBlockSchema,
  DatabaseBlockSchemaExtension,
} from "@virgultum/model";

import { DatabaseReferenceAdapterExtensions } from "./reference-adapters";

export type DatabaseReferenceBlockProps = DatabaseBlockProps;
export {
  DatabaseBlockModel as DatabaseReferenceBlockModel,
  DatabaseBlockSchema as DatabaseReferenceBlockSchema,
};

/**
 * Keeps the persisted Database reference decodable without installing or
 * rehydrating the historical local data model.
 */
export class DatabaseReferenceStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-database-reference";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(DatabaseBlockSchemaExtension);
    context.register(DatabaseReferenceAdapterExtensions);
  }
}
