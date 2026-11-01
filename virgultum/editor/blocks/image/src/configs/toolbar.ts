import { updateBlockAlign } from "@virgultum/block-note";
import { ImageBlockModel, TextAlign } from "@virgultum/model";
import {
  ActionPlacement,
  blockCommentToolbarButton,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
  editorMessage,
} from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";

import { ImageBlockComponent } from "../image-block";
import { ImageEdgelessBlockComponent } from "../image-edgeless-block";
import { duplicate } from "../utils";

const trackBaseProps = {
  category: "image",
  type: "card view",
};

const builtinToolbarConfig = {
  actions: [
    {
      id: "a.download",
      tooltip: editorMessage("com.myoxus.attachment.download", "Download"),
      icon: "DownloadIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageBlockComponent);
        block?.download();
      },
    },
    {
      id: "b.caption",
      tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
      icon: "CaptionIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageBlockComponent);
        block?.captionEditor?.show();

        ctx.track("OpenedCaptionEditor", {
          ...trackBaseProps,
          control: "add caption",
        });
      },
    },
    {
      id: "c.1.align-left",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.align-left",
        "Align left",
      ),
      icon: "TextAlignLeftIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageBlockComponent);
        if (block) {
          ctx.chain
            .pipe(updateBlockAlign, {
              textAlign: TextAlign.Left,
              selectedBlocks: [block],
            })
            .run();
        }
      },
    },
    {
      id: "c.2.align-center",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.align-center",
        "Align center",
      ),
      icon: "TextAlignCenterIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageBlockComponent);
        if (block) {
          ctx.chain
            .pipe(updateBlockAlign, {
              textAlign: TextAlign.Center,
              selectedBlocks: [block],
            })
            .run();
        }
      },
    },
    {
      id: "c.3.align-right",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.align-right",
        "Align right",
      ),
      icon: "TextAlignRightIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageBlockComponent);
        if (block) {
          ctx.chain
            .pipe(updateBlockAlign, {
              textAlign: TextAlign.Right,
              selectedBlocks: [block],
            })
            .run();
        }
      },
    },
    {
      id: "d.comment",
      ...blockCommentToolbarButton,
    },
    {
      placement: ActionPlacement.More,
      id: "a.clipboard",
      actions: [
        {
          id: "a.copy",
          label: editorMessage("Copy", "Copy"),
          icon: "CopyIcon",
          run(ctx) {
            const block = ctx.getCurrentBlockByType(ImageBlockComponent);
            block?.copy();
          },
        },
        {
          id: "b.duplicate",
          label: editorMessage(
            "com.myoxus.editor.keyboard.duplicate",
            "Duplicate",
          ),
          icon: "DuplicateIcon",
          run(ctx) {
            const block = ctx.getCurrentBlockByType(ImageBlockComponent);
            if (!block) return;

            duplicate(block);
          },
        },
      ],
    },
    {
      placement: ActionPlacement.More,
      id: "b.conversions",
      actions: [
        {
          id: "a.turn-into-card-view",
          label: editorMessage(
            "com.myoxus.editor.toolbar.turn-into-card-view",
            "Turn into card view",
          ),
          icon: "BookmarkIcon",
          when(ctx) {
            const supported =
              ctx.store.schema.flavourSchemaMap.has("myoxus:attachment");
            if (!supported) return false;

            const block = ctx.getCurrentBlockByType(ImageBlockComponent);
            return Boolean(block?.blobUrl);
          },
          run(ctx) {
            const block = ctx.getCurrentBlockByType(ImageBlockComponent);
            block?.convertToCardView();
          },
        },
      ],
    },
    {
      placement: ActionPlacement.More,
      id: "c.delete",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      variant: "destructive",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageBlockComponent);
        if (!block) return;

        ctx.store.deleteBlock(block.model);
      },
    },
  ],

  placement: "inner",
} as const satisfies ToolbarModuleConfig;

const builtinSurfaceToolbarConfig = {
  actions: [
    {
      id: "a.download",
      tooltip: editorMessage("com.myoxus.attachment.download", "Download"),
      icon: "DownloadIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageEdgelessBlockComponent);
        block?.download();
      },
    },
    {
      id: "b.caption",
      tooltip: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
      icon: "CaptionIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(ImageEdgelessBlockComponent);
        block?.captionEditor?.show();

        ctx.track("OpenedCaptionEditor", {
          ...trackBaseProps,
          control: "add caption",
        });
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(ImageBlockModel).length === 1,
} as const satisfies ToolbarModuleConfig;

export const createBuiltinToolbarConfigExtension = (
  flavour: string,
): ExtensionType[] => {
  const name = flavour.split(":").pop();

  return [
    ToolbarModuleExtension({
      id: BlockFlavourIdentifier(flavour),
      config: builtinToolbarConfig,
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier(`affine:surface:${name}`),
      config: builtinSurfaceToolbarConfig,
    }),
  ];
};
