// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { LifeCycleWatcher } from "@virgultum/editor/std";

import { buildAIPanelConfig } from "../ai-panel";
import { setupEdgelessCopilot } from "../entries/edgeless";
import { setupSpaceAIEntry } from "../entries/space/setup-space";
import { AIPanelControllerIdentifier } from "../widgets/ai-panel/controller";
import { EdgelessCopilotWidget } from "../widgets/edgeless-copilot";

const EDGELESS_PANEL_WIDTH =
  "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 10 + calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs)))";

export function getAIEdgelessRootWatcher() {
  return class AIEdgelessRootWatcher extends LifeCycleWatcher {
    static override key = "ai-edgeless-root-watcher";

    override mounted(): void {
      super.mounted();

      const panel = this.std.getOptional(AIPanelControllerIdentifier);
      if (panel) {
        panel.element.style.width = EDGELESS_PANEL_WIDTH;
        panel.config = buildAIPanelConfig(panel);
        setupSpaceAIEntry(panel);
      }

      this.std.view.viewUpdated.subscribe((payload) => {
        if (payload.type !== "widget" || payload.method !== "add") return;
        if (payload.view instanceof EdgelessCopilotWidget) {
          setupEdgelessCopilot(payload.view);
        }
      });
    }
  };
}
