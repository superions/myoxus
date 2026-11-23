import { BlockViewExtension } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";

export const AIChatBlockSpec: ExtensionType[] = [
  BlockViewExtension("myoxus:embed-ai-chat", (model) => {
    const parent = model.store.getParent(model.id);

    if (parent?.flavour === "myoxus:surface") {
      return "myoxus-edgeless-ai-chat";
    }

    return "myoxus-ai-chat";
  }),
];
