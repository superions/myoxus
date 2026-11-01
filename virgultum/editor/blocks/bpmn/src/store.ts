import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { BpmnBlockSchemaExtension } from "@virgultum/model";

import { BpmnBlockAdapterExtensions } from "./adapters/extension.js";

export class BpmnStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-bpmn-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(BpmnBlockSchemaExtension);
    context.register(BpmnBlockAdapterExtensions);
  }
}
