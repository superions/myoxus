import { ParagraphBlockSchema } from "@virgultum/core/models";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/core/adapters";
import type { DeltaInsert } from "@virgultum/core/store";

export const paragraphBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher =
  {
    flavour: ParagraphBlockSchema.model.flavour,
    toMatch: () => false,
    fromMatch: (o) => o.node.flavour === ParagraphBlockSchema.model.flavour,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        const text = (o.node.props.text ?? { delta: [] }) as {
          delta: DeltaInsert[];
        };
        const { deltaConverter } = context;
        const buffer = deltaConverter.deltaToAST(text.delta).join("");
        context.textBuffer.content += buffer;
        context.textBuffer.content += "\n";
      },
    },
  };

export const ParagraphBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(paragraphBlockPlainTextAdapterMatcher);
