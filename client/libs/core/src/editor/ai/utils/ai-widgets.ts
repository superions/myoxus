import type { EditorHost } from "@virgultum/editor/std";

import {
  MYOXUS_AI_PANEL_WIDGET,
  MyoxusAIPanelWidget,
} from "../widgets/ai-panel/ai-panel";

export const getAIPanelWidget = (host: EditorHost): MyoxusAIPanelWidget => {
  const rootBlockId = host.store.root?.id;
  if (!rootBlockId) {
    throw new Error("rootBlockId is not found");
  }
  const aiPanel = host.view.getWidget(MYOXUS_AI_PANEL_WIDGET, rootBlockId);
  if (!(aiPanel instanceof MyoxusAIPanelWidget)) {
    throw new Error("AI panel not found");
  }
  return aiPanel;
};
