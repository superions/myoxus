import {
  type HtmlAST,
  HtmlASTToDeltaExtension,
} from "@virgultum/shared/adapters";
import type { Element } from "hast";

const isElement = (ast: HtmlAST): ast is Element => {
  return ast.type === "element";
};

export const htmlLinkElementToDeltaMatcher = HtmlASTToDeltaExtension({
  name: "link-element",
  match: (ast) => isElement(ast) && ast.tagName === "a",
  toDelta: (ast, context) => {
    if (!isElement(ast)) {
      return [];
    }
    const href = ast.properties?.href;
    if (typeof href !== "string")
      return ast.children.flatMap((child) =>
        context.toDelta(child, { trim: false }),
      );
    // Keep source labels and formatting until the containing inline run has
    // recognized annotations/code. The shared converter resolves normal links
    // through the registered Markdown reference matcher after that boundary.
    return ast.children.flatMap((child) =>
      context.toDelta(child, { trim: false }).map((delta) => {
        if (href) {
          delta.attributes = {
            ...delta.attributes,
            link: href,
          };
          return delta;
        }
        return delta;
      }),
    );
  },
});
