import { ImageBlockSchema } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  type MarkdownAST,
} from "@virgultum/shared/adapters";
import { getAssetName } from "@virgultum/store";

import { processImageNodeToBlock } from "./utils";

const isImageNode = (node: MarkdownAST) => node.type === "image";

export const imageBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: ImageBlockSchema.model.flavour,
  toMatch: (o) => isImageNode(o.node),
  fromMatch: (o) => o.node.flavour === ImageBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: async (o, context) => {
      const { configs, walkerContext, assets } = context;
      const imageURL = "url" in o.node ? o.node.url : "";
      let parent = o.parent;
      let footnoteLabel: string | undefined;
      while (parent) {
        if (parent.node.type === "footnoteDefinition")
          footnoteLabel = parent.node.label ?? parent.node.identifier;
        parent = parent.parent;
      }
      if (!assets || !imageURL) {
        if (footnoteLabel !== undefined)
          throw new Error(`Footnote image unavailable: ${footnoteLabel}`);
        return;
      }
      await processImageNodeToBlock(
        imageURL,
        walkerContext,
        assets,
        configs,
        footnoteLabel,
      );
    },
  },
  fromBlockSnapshot: {
    enter: async (o, context) => {
      const { assets, walkerContext, updateAssetIds } = context;
      const blobId = (o.node.props.sourceId ?? "") as string;
      let parent = o.parent;
      let footnoteLabel: string | undefined;
      while (parent) {
        if (parent.node.flavour === "myoxus:footnote-definition")
          footnoteLabel = String(parent.node.props.label);
        parent = parent.parent;
      }
      if (!assets) {
        if (footnoteLabel !== undefined)
          throw new Error(`Footnote image unavailable: ${footnoteLabel}`);
        return;
      }
      await assets.readFromBlob(blobId);
      const blob = assets.getAssets().get(blobId);
      if (!blob) {
        if (footnoteLabel !== undefined)
          throw new Error(`Footnote image unavailable: ${footnoteLabel}`);
        return;
      }
      const blobName = getAssetName(assets.getAssets(), blobId);
      updateAssetIds?.(blobId);
      walkerContext
        .openNode(
          {
            type: "paragraph",
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "image",
            // Asset inventory keys are filenames, not already encoded URLs.
            url: `assets/${encodeURIComponent(blobName)}`,
            title: (o.node.props.caption as string | undefined) ?? null,
            alt: (blob as File).name ?? null,
          },
          "children",
        )
        .closeNode()
        .closeNode();
    },
  },
};

export const ImageBlockMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  imageBlockMarkdownAdapterMatcher,
);
