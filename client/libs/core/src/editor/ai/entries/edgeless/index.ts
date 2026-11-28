// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { sortEdgelessElements } from "@virgultum/editor/blocks/root";
import type { DocMode } from "@virgultum/editor/model";
import {
  ActionPlacement,
  editorMessage,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";
import {
  GfxControllerIdentifier,
  isGfxGroupCompatibleModel,
} from "@virgultum/editor/std/gfx";

import { AIProvider } from "../../provider";
import { CopilotTool } from "../../tool/copilot-tool";
import { getAIPanelController } from "../../utils/ai-widgets";
import { getEdgelessCopilotWidget } from "../../utils/edgeless";
import { extractSelectedContent } from "../../utils/extract";
import type { EdgelessCopilotWidget } from "../../widgets/edgeless-copilot";
import { edgelessAIGroups } from "./actions-config";

export function setupEdgelessCopilot(widget: EdgelessCopilotWidget): void {
  widget.groups = edgelessAIGroups;
}

export function edgelessToolbarAIEntryConfig(): ToolbarModuleConfig {
  return {
    actions: [
      {
        placement: ActionPlacement.Start,
        id: "A.ai",
        score: -1,
        when(ctx) {
          const models = ctx.getSurfaceModels();
          return models.length > 0 && !models.some((model) => model.isLocked());
        },
        generate: ({ host, chain }) => {
          const hasAnyAction = edgelessAIGroups.some((group) =>
            group.items.some((item) =>
              item.showWhen?.(chain, "edgeless" as DocMode, host),
            ),
          );
          if (!hasAnyAction) return null;

          return {
            label: editorMessage("com.myoxus.editor.toolbar.ask-ai", "Ask AI"),
            icon: "AiIcon",
            run: () => {
              const panel = getAIPanelController(host);
              if (panel.config) {
                panel.config.generateAnswer = ({ finish, input }) => {
                  finish("success");
                  panel.hide();
                  extractSelectedContent(host)
                    .then((context) => {
                      if (
                        context?.attachments?.length ||
                        context?.docs?.length
                      ) {
                        AIProvider.slots.requestOpenWithChat.next({
                          input,
                          host,
                          context,
                          autoSelect: true,
                        });
                      } else {
                        AIProvider.slots.requestSendWithChat.next({
                          input,
                          context,
                          host,
                        });
                      }
                    })
                    .catch(console.error);
                };
                panel.config.inputCallback = (text) => {
                  getEdgelessCopilotWidget(host).setCopilotPanelVisible(!text);
                };
              }

              const gfx = host.std.get(GfxControllerIdentifier);
              const selected = sortEdgelessElements(
                gfx.selection.selectedElements,
              );
              const expanded = new Set(selected);
              for (const element of selected) {
                if (isGfxGroupCompatibleModel(element)) {
                  for (const child of element.descendantElements) {
                    expanded.add(child);
                  }
                }
              }

              gfx.tool.setTool(CopilotTool);
              (gfx.tool.currentTool$.peek() as CopilotTool).updateSelectionWith(
                Array.from(expanded),
                10,
              );
            },
          };
        },
      },
    ],
  };
}
