// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ImageBlockComponent } from "@virgultum/editor/blocks/image";
import {
  ActionPlacement,
  editorMessage,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";
import { BlockSelection } from "@virgultum/editor/std";

import { buildAIImageItemGroups } from "../../_common/config";
import { aiToolbarActions } from "../toolbar-actions";

const imageActionGroups = buildAIImageItemGroups();

export function imageToolbarAIEntryConfig(): ToolbarModuleConfig {
  return {
    actions: [
      {
        placement: ActionPlacement.Start,
        id: "A.ai",
        score: -1,
        label: editorMessage("com.myoxus.editor.toolbar.ask-ai", "Ask AI"),
        icon: "AiIcon",
        control(ctx) {
          const imageBlock = ctx.getCurrentBlockByType(ImageBlockComponent);
          if (!imageBlock) return null;

          return {
            type: "menu",
            items: aiToolbarActions(ctx, imageActionGroups),
            onOpen: () =>
              ctx.selection.update(() => [
                ctx.selection.create(BlockSelection, {
                  blockId: imageBlock.blockId,
                }),
              ]),
          };
        },
      },
    ],
  };
}
