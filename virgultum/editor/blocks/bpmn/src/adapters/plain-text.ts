import { BpmnBlockSchema } from "@virgultum/model";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/shared/adapters";

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
