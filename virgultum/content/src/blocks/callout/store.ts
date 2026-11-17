import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { CalloutBlockSchemaExtension } from "@virgultum/core/models";

import { CalloutBlockMarkdownAdapterExtension } from "./adapters/markdown";
import { CalloutBlockHtmlAdapterExtension } from "./adapters/html";

export class CalloutStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-callout-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(CalloutBlockSchemaExtension);
    context.register(CalloutBlockMarkdownAdapterExtension);
    context.register(CalloutBlockHtmlAdapterExtension);
  }
}
