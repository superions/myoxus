import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { MermaidBlockSchemaExtension } from "@virgultum/model";

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
