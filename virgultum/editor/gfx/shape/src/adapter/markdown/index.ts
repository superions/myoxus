import { ElementToMarkdownAdapterExtension } from "@virgultum/block-surface";

import { getShapeText, getShapeType } from "../utils";

export const shapeToMarkdownAdapterMatcher = ElementToMarkdownAdapterExtension({
  name: "shape",
  match: (elementModel) => elementModel.type === "shape",
  toAST: (elementModel) => {
    let content = "";
    // Export the standalone shape label and shape type.
    const text = getShapeText(elementModel);
    const type = getShapeType(elementModel);
    if (!text && !type) {
      return null;
    }

    const shapeType = type.charAt(0).toUpperCase() + type.slice(1);
    content = `${shapeType}, with text label "${text}"`;
    return {
      type: "paragraph",
      children: [
        {
          type: "text",
          value: content,
        },
      ],
    };
  },
});
