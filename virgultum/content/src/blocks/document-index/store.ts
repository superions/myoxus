// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  StoreExtensionProvider,
  type StoreExtensionContext,
} from "@virgultum/core/extensions";
import { DocumentIndexBlockSchemaExtension } from "@virgultum/core/models";
import { documentIndexAdapters } from "./adapters";
export class DocumentIndexStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-document-index";
  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([
      DocumentIndexBlockSchemaExtension,
      ...documentIndexAdapters,
    ]);
  }
}
