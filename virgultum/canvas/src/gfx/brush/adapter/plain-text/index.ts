import { ElementToPlainTextAdapterExtension } from "@virgultum/canvas-runtime/adapters";

export const brushToPlainTextAdapterMatcher =
  ElementToPlainTextAdapterExtension({
    name: "brush",
    match: (elementModel) => elementModel.type === "brush",
    toAST: () => {
      const content = `Brush Stroke`;
      return { content };
    },
  });
