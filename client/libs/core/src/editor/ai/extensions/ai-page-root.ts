import { LifeCycleWatcher } from "@virgultum/editor/std";

import { buildAIPanelConfig } from "../ai-panel";
import { setupSpaceAIEntry } from "../entries/space/setup-space";
import { MyoxusAIPanelWidget } from "../widgets/ai-panel/ai-panel";

export function getAIPageRootWatcher() {
  class AIPageRootWatcher extends LifeCycleWatcher {
    static override key = "ai-page-root-watcher";

    override mounted() {
      super.mounted();
      const { view } = this.std;
      view.viewUpdated.subscribe((payload) => {
        if (payload.type !== "widget" || payload.method !== "add") {
          return;
        }
        const component = payload.view;
        if (component instanceof MyoxusAIPanelWidget) {
          component.style.width =
            "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 15 + calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))\n  )";
          component.config = buildAIPanelConfig(component);
          setupSpaceAIEntry(component);
        }
      });
    }
  }
  return AIPageRootWatcher;
}
