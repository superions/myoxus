import { BpmnBlockSchema } from "@virgultum/core/models";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/core/adapters";

import { getBpmnBlockExportLabel } from "../utils.js";

export const bpmnBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher = {
  flavour: BpmnBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === BpmnBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (o, context) => {
      context.textBuffer.content += `[${getBpmnBlockExportLabel(o.node.props)}]\n`;
    },
  },
};

export const BpmnBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(bpmnBlockPlainTextAdapterMatcher);
