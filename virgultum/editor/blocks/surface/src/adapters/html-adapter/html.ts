import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
} from "@virgultum/shared/adapters";

export const surfaceBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: "myoxus:surface",
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === "myoxus:surface",
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (_, context) => {
      context.walkerContext.skipAllChildren();
    },
  },
};

export const SurfaceBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  surfaceBlockHtmlAdapterMatcher,
);
