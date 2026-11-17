import { MermaidBlockSchema } from "@virgultum/core/models";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/core/adapters";

import { getMermaidBlockSource } from "../utils.js";

export const mermaidBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher =
  {
    flavour: MermaidBlockSchema.model.flavour,
    toMatch: () => false,
    fromMatch: (o) => o.node.flavour === MermaidBlockSchema.model.flavour,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: async (o, context) => {
        const { getMermaidEffectiveBlockExportLabel } =
          await import("../mermaid-title-projection.js");
        context.textBuffer.content += `[${getMermaidEffectiveBlockExportLabel(
          o.node.props,
        )}]\n${getMermaidBlockSource(o.node.props)}\n`;
      },
    },
  };

export const MermaidBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(mermaidBlockPlainTextAdapterMatcher);
