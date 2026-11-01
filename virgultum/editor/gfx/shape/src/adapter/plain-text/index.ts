import { ElementToPlainTextAdapterExtension } from "@virgultum/block-surface";

import { getShapeText, getShapeType } from "../utils";

export const shapeToPlainTextAdapterMatcher =
  ElementToPlainTextAdapterExtension({
    name: "shape",
    match: (elementModel) => elementModel.type === "shape",
    toAST: (elementModel) => {
      let content = "";
      // Export the standalone shape label and shape type.
      const text = getShapeText(elementModel);
      const type = getShapeType(elementModel);
      const shapeType = type.charAt(0).toUpperCase() + type.slice(1);
      content = `${shapeType}, with text label "${text}"`;
      return { content };
    },
  });
