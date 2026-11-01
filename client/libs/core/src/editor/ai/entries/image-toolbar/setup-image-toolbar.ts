import { ImageBlockComponent } from "@virgultum/editor/blocks/image";
import {
  ActionPlacement,
  editorMessage,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";
import { BlockSelection } from "@virgultum/editor/std";
import { aiToolbarActions } from "../toolbar-actions";

import { buildAIImageItemGroups } from "../../_common/config";

const AIImageItemGroups = buildAIImageItemGroups();

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
          const block = ctx.getCurrentBlockByType(ImageBlockComponent);
          if (!block) return null;
          return {
            type: "menu",
            items: aiToolbarActions(ctx, AIImageItemGroups),
            onOpen: () =>
              ctx.selection.update(() => [
                ctx.selection.create(BlockSelection, {
                  blockId: block.blockId,
                }),
              ]),
          };
        },
      },
    ],
  };
}
