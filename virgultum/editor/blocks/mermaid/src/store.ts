import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { MermaidBlockSchemaExtension } from "@virgultum/core/models";

import { MermaidBlockAdapterExtensions } from "./adapters/extension.js";
import { MermaidOwnerMigrationExtension } from "./presentation/mermaid-owner-migration-extension.js";

export class MermaidStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-mermaid-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(MermaidBlockSchemaExtension);
    context.register(MermaidBlockAdapterExtensions);
    context.register(MermaidOwnerMigrationExtension);
  }
}
