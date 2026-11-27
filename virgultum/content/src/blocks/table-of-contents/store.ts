// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  StoreExtensionProvider,
  type StoreExtensionContext,
} from "@virgultum/core/extensions";
import { TableOfContentsBlockSchemaExtension } from "@virgultum/core/models";
import { tableOfContentsAdapters } from "./adapters";

export class TableOfContentsStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-table-of-contents";
  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([
      TableOfContentsBlockSchemaExtension,
      ...tableOfContentsAdapters,
    ]);
  }
}
