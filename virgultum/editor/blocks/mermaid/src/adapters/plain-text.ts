import { MermaidBlockSchema } from "@virgultum/model";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/shared/adapters";

import { getMermaidBlockSource } from "../utils.js";
import { getMermaidEffectiveBlockExportLabel } from "../mermaid-title-projection.js";

export const mermaidBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher =
  {
    flavour: MermaidBlockSchema.model.flavour,
    toMatch: () => false,
    fromMatch: (o) => o.node.flavour === MermaidBlockSchema.model.flavour,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        context.textBuffer.content += `[${getMermaidEffectiveBlockExportLabel(
          o.node.props,
        )}]\n${getMermaidBlockSource(o.node.props)}\n`;
      },
    },
  };

export const MermaidBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(mermaidBlockPlainTextAdapterMatcher);
