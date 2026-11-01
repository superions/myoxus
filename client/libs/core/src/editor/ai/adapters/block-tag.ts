import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
} from "@virgultum/shared/adapters";

export const blockTagMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: "myoxus:page/affine:note/*",
  toMatch: () => false,
  fromMatch: (o) => {
    const block = o.node;
    const parent = o.parent;
    if (block.type === "block" && parent?.node.flavour === "myoxus:note") {
      return true;
    }
    return false;
  },
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    async enter(block, adapterContext) {
      adapterContext.walkerContext
        .openNode({
          type: "html",
          value: `<!-- block_id=${block.node.id} flavour=${block.node.flavour} -->`,
        })
        .closeNode();
    },
  },
};

export const BlockTagMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  blockTagMarkdownAdapterMatcher,
);
