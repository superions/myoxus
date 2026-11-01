import { BlockViewExtension } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import { literal } from "lit/static-html.js";

export const AIChatBlockSpec: ExtensionType[] = [
  BlockViewExtension("myoxus:embed-ai-chat", (model) => {
    const parent = model.store.getParent(model.id);

    if (parent?.flavour === "myoxus:surface") {
      return literal`myoxus-edgeless-ai-chat`;
    }

    return literal`myoxus-ai-chat`;
  }),
];
