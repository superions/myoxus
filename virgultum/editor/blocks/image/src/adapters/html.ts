import { ImageBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
} from "@virgultum/shared/adapters";
import { getAssetName } from "@virgultum/store";

import { processImageNodeToBlock } from "./utils";

export const imageBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: ImageBlockSchema.model.flavour,
  toMatch: (o) => HastUtils.isElement(o.node) && o.node.tagName === "img",
  fromMatch: (o) => o.node.flavour === ImageBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: async (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { assets, walkerContext, configs } = context;
      let parent = o.parent;
      let footnoteLabel: string | undefined;
      while (parent) {
        if (
          HastUtils.isElement(parent.node) &&
          parent.node.properties.dataMyoxusFootnoteDefinition !== undefined
        )
          footnoteLabel = String(
            parent.node.properties.dataMyoxusFootnoteLabel,
          );
        parent = parent.parent;
      }
      if (!assets) {
        if (footnoteLabel !== undefined)
          throw new Error(`Footnote image unavailable: ${footnoteLabel}`);
        return;
      }
      const image = o.node;
      const imageURL =
        typeof image?.properties.src === "string" ? image.properties.src : "";
      if (!imageURL) {
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
      const blobId = (o.node.props.sourceId ?? "") as string;
      const { assets, walkerContext, updateAssetIds } = context;
      if (!assets) {
        return;
      }

      await assets.readFromBlob(blobId);
      const blob = assets.getAssets().get(blobId);
      updateAssetIds?.(blobId);
      if (!blob) {
        let parent = o.parent;
        while (parent) {
          if (parent.node.flavour === "myoxus:footnote-definition")
            throw new Error("Footnote image unavailable for HTML export");
          parent = parent.parent;
        }
        return;
      }
      const blobName = getAssetName(assets.getAssets(), blobId);
      const isScaledImage = o.node.props.width && o.node.props.height;
      const widthStyle = isScaledImage
        ? {
            width: `${o.node.props.width}px`,
            height: `${o.node.props.height}px`,
          }
        : {};

      walkerContext
        .openNode(
          {
            type: "element",
            tagName: "figure",
            properties: {
              className: ["myoxus-image-block-container"],
            },
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "element",
            tagName: "img",
            properties: {
              src: `assets/${blobName}`,
              alt: blobName,
              title: (o.node.props.caption as string | undefined) ?? null,
              ...widthStyle,
            },
            children: [],
          },
          "children",
        )
        .closeNode()
        .closeNode();
    },
  },
};

export const ImageBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  imageBlockHtmlAdapterMatcher,
);
