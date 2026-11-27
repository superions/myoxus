import type { EditorHost } from "@virgultum/editor/std";

import {
  type AIPanelController,
  AIPanelControllerIdentifier,
} from "../widgets/ai-panel/controller";

export const getAIPanelController = (host: EditorHost): AIPanelController => {
  const aiPanel = host.std.getOptional(AIPanelControllerIdentifier);
  if (!aiPanel) {
    throw new Error("AI panel not found");
  }
  return aiPanel;
};
