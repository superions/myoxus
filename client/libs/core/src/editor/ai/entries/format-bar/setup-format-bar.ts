// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  ActionPlacement,
  editorMessage,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";
import { BlockSelection, TextSelection } from "@virgultum/editor/std";

import { pageAIGroups } from "../../_common/config";
import { AIProvider } from "../../provider";
import { extractSelectedContent } from "../../utils/extract";
import { AIPanelControllerIdentifier } from "../../widgets/ai-panel/controller";
import { aiToolbarActions } from "../toolbar-actions";

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
              const { host } = ctx;
              const panel = host.std.getOptional(AIPanelControllerIdentifier);
              if (!panel?.config) return;

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

              const textSel = host.selection.find(TextSelection);
              const blockSels = host.selection.filter(BlockSelection);
              const targetId = textSel
                ? (textSel.to?.blockId ?? textSel.blockId)
                : blockSels.at(-1)?.blockId;
              if (!targetId) return;

              const block = host.view.getBlock(targetId);
              if (block) {
                panel.setState("input", block);
              }
            },
          };
        },
      },
    ],
  };
}
