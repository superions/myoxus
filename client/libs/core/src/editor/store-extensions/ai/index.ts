import { AIChatBlockSchemaExtension } from "@myoxus/core/editor/ai/blocks/ai-chat-block/model";
import { TranscriptionBlockSchemaExtension } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/editor/ext-loader";

export class AIStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-store-extensions";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(AIChatBlockSchemaExtension);
    context.register(TranscriptionBlockSchemaExtension);
  }
}
