// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { EventBlockSchemaExtension } from "@virgultum/model";

import { EventBlockAdapterExtensions } from "./adapters/extension.js";

export class EventStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-event-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(EventBlockSchemaExtension);
    context.register(EventBlockAdapterExtensions);
  }
}
