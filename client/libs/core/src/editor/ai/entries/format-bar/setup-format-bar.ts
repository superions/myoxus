import {
  ActionPlacement,
  editorMessage,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";
import { BlockSelection, TextSelection } from "@virgultum/editor/std";
import { getAIPanelWidget } from "../../utils/ai-widgets";
import { extractSelectedContent } from "../../utils/extract";
import { AIProvider } from "../../provider";
import { aiToolbarActions } from "../toolbar-actions";

import { pageAIGroups } from "../../_common/config";

export function toolbarAIEntryConfig(): ToolbarModuleConfig {
  return {
    actions: [
      {
        placement: ActionPlacement.Start,
        id: "A.ai",
        score: -1,
        when: ({ flags }) => !flags.isNative(),
        label: editorMessage("com.myoxus.editor.toolbar.ask-ai", "Ask AI"),
        icon: "AiIcon",
        control(ctx) {
          return {
            type: "menu",
            items: aiToolbarActions(ctx, pageAIGroups, true),
            onOpen: () => {
              const host = ctx.host,
                panel = getAIPanelWidget(host);
              if (!panel.config) return;
              panel.config.generateAnswer = ({ finish, input }) => {
                finish("success");
                panel.hide();
                extractSelectedContent(host)
                  .then((context) =>
                    AIProvider.slots.requestSendWithChat.next({
                      input,
                      context,
                      host,
                    }),
                  )
                  .catch(console.error);
              };
              panel.config.inputCallback = (text) => {
                if (text) ctx.hide();
              };
              const text = host.selection.find(TextSelection);
              const blocks = host.selection.filter(BlockSelection);
              const id = text
                ? (text.to?.blockId ?? text.blockId)
                : blocks.at(-1)?.blockId;
              if (!id) return;
              const block = host.view.getBlock(id);
              if (block) panel.setState("input", block);
            },
          };
        },
      },
    ],
  };
}
