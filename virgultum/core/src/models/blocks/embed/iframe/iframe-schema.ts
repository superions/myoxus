import {
  BlockSchemaExtension,
  defineBlockSchema,
} from "../../../../store/index";

import { defaultEmbedIframeProps, EmbedIframeBlockModel } from "./iframe-model";

export const EmbedIframeBlockSchema = defineBlockSchema({
  flavour: "myoxus:embed-iframe",
  props: () => defaultEmbedIframeProps,
  metadata: {
    version: 1,
    role: "content",
  },
  toModel: () => new EmbedIframeBlockModel(),
});

export const EmbedIframeBlockSchemaExtension = BlockSchemaExtension(
  EmbedIframeBlockSchema,
);
