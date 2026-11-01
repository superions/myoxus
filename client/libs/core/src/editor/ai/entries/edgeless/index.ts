import type { DocMode } from "@virgultum/editor/model";
import {
  ActionPlacement,
  editorMessage,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";

import type { AIItemGroupConfig } from "../../components/ai-item/types";
import { AIProvider } from "../../provider";
import { getAIPanelWidget } from "../../utils/ai-widgets";
import { getEdgelessCopilotWidget } from "../../utils/edgeless";
import { extractSelectedContent } from "../../utils/extract";
import type { EdgelessCopilotWidget } from "../../widgets/edgeless-copilot";
import { sortEdgelessElements } from "@virgultum/editor/blocks/root";
import {
  GfxControllerIdentifier,
  isGfxGroupCompatibleModel,
} from "@virgultum/editor/std/gfx";
import { CopilotTool } from "../../tool/copilot-tool";
import { edgelessAIGroups } from "./actions-config";

export function setupEdgelessCopilot(widget: EdgelessCopilotWidget) {
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
          const filteredGroups = edgelessAIGroups.reduce<AIItemGroupConfig[]>(
            (pre, group) => {
              const filtered = group.items.filter((item) =>
                item.showWhen?.(chain, "edgeless" as DocMode, host),
              );

              if (filtered.length > 0) pre.push({ ...group, items: filtered });

              return pre;
            },
            [],
          );

          if (filteredGroups.every((group) => group.items.length === 0))
            return null;

          const handler = () => {
            const aiPanel = getAIPanelWidget(host);
            if (aiPanel.config) {
              aiPanel.config.generateAnswer = ({ finish, input }) => {
                finish("success");
                aiPanel.hide();
                extractSelectedContent(host)
                  .then((context) => {
                    if (context?.attachments?.length || context?.docs?.length) {
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
              aiPanel.config.inputCallback = (text) => {
                const copilotWidget = getEdgelessCopilotWidget(host);
                const panel = copilotWidget.shadowRoot?.querySelector(
                  "edgeless-copilot-panel",
                );
                if (panel instanceof HTMLElement) {
                  panel.style.visibility = text ? "hidden" : "visible";
                }
              };
            }
          };

          return {
            label: editorMessage("com.myoxus.editor.toolbar.ask-ai", "Ask AI"),
            icon: "AiIcon",
            run: () => {
              handler();
              const gfx = host.std.get(GfxControllerIdentifier);
              const selected = sortEdgelessElements(
                gfx.selection.selectedElements,
              );
              const all = new Set(selected);
              selected.forEach((element) => {
                if (all.has(element)) return;
                all.add(element);
                if (isGfxGroupCompatibleModel(element))
                  element.descendantElements.forEach((child) => all.add(child));
              });
              gfx.tool.setTool(CopilotTool);
              (gfx.tool.currentTool$.peek() as CopilotTool).updateSelectionWith(
                [...all],
                10,
              );
            },
          };
        },
      },
    ],
  };
}
