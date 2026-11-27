import { LifeCycleWatcher } from "@virgultum/editor/std";

import { buildAIPanelConfig } from "../ai-panel";
import { setupEdgelessCopilot } from "../entries/edgeless/index";
import { setupSpaceAIEntry } from "../entries/space/setup-space";
import { AIPanelControllerIdentifier } from "../widgets/ai-panel/controller";
import { EdgelessCopilotWidget } from "../widgets/edgeless-copilot";

export function getAIEdgelessRootWatcher() {
  class AIEdgelessRootWatcher extends LifeCycleWatcher {
    static override key = "ai-edgeless-root-watcher";

    override mounted() {
      super.mounted();
      const panel = this.std.getOptional(AIPanelControllerIdentifier);
      if (panel) {
        panel.element.style.width =
          "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 10 + calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))\n  )";
        panel.config = buildAIPanelConfig(panel);
        setupSpaceAIEntry(panel);
      }

      const { view } = this.std;
      view.viewUpdated.subscribe((payload) => {
        if (payload.type !== "widget" || payload.method !== "add") {
          return;
        }
        const component = payload.view;
        if (component instanceof EdgelessCopilotWidget) {
          setupEdgelessCopilot(component);
        }
      });
    }
  }
  return AIEdgelessRootWatcher;
}
