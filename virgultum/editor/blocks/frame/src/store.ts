import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { FrameBlockSchemaExtension } from "@virgultum/model";

export class FrameStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-frame-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([FrameBlockSchemaExtension]);
  }
}
