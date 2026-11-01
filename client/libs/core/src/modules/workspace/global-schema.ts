import { AIChatBlockSchema } from "@myoxus/core/editor/ai/blocks/ai-chat-block/model";
import { TranscriptionBlockSchema } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import { MyoxusSchemas } from "@virgultum/editor/schemas";
import { Schema } from "@virgultum/editor/store";

let _schema: Schema | null = null;
export function getMyoxusWorkspaceSchema() {
  if (!_schema) {
    _schema = new Schema();

    _schema.register([
      ...MyoxusSchemas,
      AIChatBlockSchema,
      TranscriptionBlockSchema,
    ]);
  }

  return _schema;
}
