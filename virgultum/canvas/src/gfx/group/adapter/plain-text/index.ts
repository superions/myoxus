import { ElementToPlainTextAdapterExtension } from "@virgultum/canvas-runtime/adapters";

import { getGroupTitle } from "../text";

export const groupToPlainTextAdapterMatcher =
  ElementToPlainTextAdapterExtension({
    name: "group",
    match: (elementModel) => elementModel.type === "group",
    toAST: (elementModel) => {
      const title = getGroupTitle(elementModel);
      const content = `Group, with title "${title}"`;
      return { content };
    },
  });
