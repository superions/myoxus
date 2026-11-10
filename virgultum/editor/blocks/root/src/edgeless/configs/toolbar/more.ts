import { AttachmentBlockComponent } from "@virgultum/block-attachment";
import { BookmarkBlockComponent } from "@virgultum/block-bookmark";
import {
  isExternalEmbedBlockComponent,
  notifyDocCreated,
  promptDocTitle,
} from "@virgultum/block-embed";
import { EdgelessFrameManagerIdentifier } from "@virgultum/block-frame";
import { ImageBlockComponent } from "@virgultum/block-image";
import {
  EdgelessCRUDIdentifier,
  getSurfaceComponent,
} from "@virgultum/block-surface";
import { createGroupFromSelectedCommand } from "@virgultum/gfx-group";
import { Bound, getCommonBoundWithRotation } from "@virgultum/global/gfx";
import {
  AttachmentBlockModel,
  BookmarkBlockModel,
  EmbedLinkedDocBlockSchema,
  EmbedLinkedDocModel,
  EmbedSyncedDocBlockSchema,
  EmbedSyncedDocModel,
  FrameBlockModel,
  ImageBlockModel,
  isExternalEmbedModel,
  NoteBlockModel,
  ParagraphBlockModel,
} from "@virgultum/model";
import {
  type ToolbarActions,
  type ToolbarContext,
  editorMessage,
} from "@virgultum/shared/services";
import { matchModels, type ReorderingType } from "@virgultum/shared/utils";
import type { BlockComponent } from "@virgultum/std";
import { GfxBlockElementModel, type GfxModel } from "@virgultum/std/gfx";

import { EdgelessClipboardController } from "../../clipboard/clipboard";
import { duplicate } from "../../utils/clipboard-utils";
import { getSortedCloneElements } from "../../utils/clone-utils";
import { moveConnectors } from "../../utils/connector";
import { deleteElements } from "../../utils/crud";
import {
  createLinkedDocFromEdgelessElements,
  createLinkedDocFromNote,
} from "./render-linked-doc";
import { getEdgelessWith } from "./utils";

export const moreActions = [
  // Selection Group: frame & group
  {
    id: "Z.a.selection",
    actions: [
      {
        id: "a.create-frame",
        label: editorMessage(
          "com.myoxus.editor.toolbar.frame-section",
          "Frame section",
        ),
        icon: "FrameIcon",
        run(ctx) {
          const frame = ctx.std
            .get(EdgelessFrameManagerIdentifier)
            .createFrameOnSelected();
          if (!frame) return;

          const surface = getSurfaceComponent(ctx.std);
          if (!surface) return;

          surface.fitToViewport(Bound.deserialize(frame.xywh));

          ctx.track("CanvasElementAdded", {
            control: "context-menu",
            type: "frame",
          });
        },
      },
      {
        id: "b.create-group",
        label: editorMessage(
          "com.myoxus.editor.toolbar.group-section",
          "Group section",
        ),
        icon: "GroupIcon",
        when(ctx) {
          const models = ctx.getSurfaceModels();
          if (models.length === 0) return false;
          return !models.some((model) =>
            ctx.matchModel(model, FrameBlockModel),
          );
        },
        run(ctx) {
          ctx.command.exec(createGroupFromSelectedCommand);
        },
      },
    ],
  },

  // Reordering Group
  {
    id: "Z.b.reordering",
    actions: [
      {
        id: "a.bring-to-front",
        label: editorMessage(
          "com.myoxus.editor.toolbar.bring-to-front",
          "Bring to Front",
        ),
        icon: "ArrowUpBigTopIcon",
        run(ctx) {
          const models = ctx.getSurfaceModels();
          reorderElements(ctx, models, "front");
        },
      },
      {
        id: "b.bring-forward",
        label: editorMessage(
          "com.myoxus.editor.toolbar.bring-forward",
          "Bring Forward",
        ),
        icon: "ArrowUpBigIcon",
        run(ctx) {
          const models = ctx.getSurfaceModels();
          reorderElements(ctx, models, "forward");
        },
      },
      {
        id: "c.send-backward",
        label: editorMessage(
          "com.myoxus.editor.toolbar.send-backward",
          "Send Backward",
        ),
        icon: "ArrowDownBigIcon",
        run(ctx) {
          const models = ctx.getSurfaceModels();
          reorderElements(ctx, models, "backward");
        },
      },
      {
        id: "c.send-to-back",
        label: editorMessage(
          "com.myoxus.editor.toolbar.send-to-back",
          "Send to Back",
        ),
        icon: "ArrowDownBigBottomIcon",
        run(ctx) {
          const models = ctx.getSurfaceModels();
          reorderElements(ctx, models, "back");
        },
      },
    ],
  },

  // Clipboard Group
  // Uses the same `ID` for both page and edgeless modes.
  {
    id: "a.clipboard",
    actions: [
      {
        id: "copy",
        label: editorMessage("Copy", "Copy"),
        icon: "CopyIcon",
        run(ctx) {
          const models = ctx.getSurfaceModels();
          if (!models.length) return;

          const edgelessClipboard = ctx.std.getOptional(
            EdgelessClipboardController,
          );
          if (!edgelessClipboard) return;

          edgelessClipboard.copy();
        },
      },
      {
        id: "duplicate",
        label: editorMessage(
          "com.myoxus.editor.keyboard.duplicate",
          "Duplicate",
        ),
        icon: "DuplicateIcon",
        run(ctx) {
          const models = ctx.getSurfaceModels();
          if (!models.length) return;

          const edgeless = getEdgelessWith(ctx);
          if (!edgeless) return;

          duplicate(edgeless, models).catch(console.error);
        },
      },
      {
        id: "reload",
        label: editorMessage("com.myoxus.editor.toolbar.reload", "Reload"),
        icon: "ResetIcon",
        when(ctx) {
          const models = ctx.getSurfaceModels();
          if (models.length === 0) return false;
          return models.every(isRefreshableModel);
        },
        run(ctx) {
          const blocks = ctx
            .getSurfaceModels()
            .map((model) => ctx.view.getBlock(model.id))
            .filter(isRefreshableBlock);

          if (!blocks.length) return;

          for (const block of blocks) {
            block.refreshData();
          }
        },
      },
    ],
  },

  // Conversions Group
  {
    id: "d.conversions",
    actions: [
      {
        id: "a.turn-into-linked-doc",
        disabled: (ctx) =>
          ctx.store.readonly ||
          ctx
            .getSurfaceModels()
            .some((model) => ctx.store.hasFixedText(model.id)),
        label: editorMessage(
          "com.myoxus.editor.toolbar.turn-into-linked-doc",
          "Turn into linked doc",
        ),
        icon: "LinkedPageIcon",
        when(ctx) {
          const models = ctx.getSurfaceModels();
          if (models.length !== 1) return false;
          return ctx.matchModel(models[0], NoteBlockModel);
        },
        run(ctx) {
          const model = ctx.getCurrentModelByType(NoteBlockModel);
          if (!model) return;
          if (ctx.store.readonly || ctx.store.hasFixedText(model)) return;

          let placeholder = "";
          for (const child of model.children) {
            if (matchModels(child, [ParagraphBlockModel])) {
              if (child.props.text.length === 0) continue;
              placeholder = child.props.text.toString();
              break;
            }
            break;
          }

          const create = async () => {
            const title = await promptDocTitle(ctx.std, placeholder);
            if (title === null) return;
            if (
              ctx.store.readonly ||
              ctx.store.getModelById(model.id) !== model ||
              ctx.store.hasFixedText(model)
            )
              return;

            const edgeless = getEdgelessWith(ctx);
            if (!edgeless) return;

            const surfaceId = edgeless.surfaceBlockModel.id;
            if (!surfaceId) return;

            const linkedDoc = createLinkedDocFromNote(ctx.store, model, title);
            if (!linkedDoc) return;

            // Inserts linked doc card
            const cardId = ctx.std.get(EdgelessCRUDIdentifier).addBlock(
              EmbedSyncedDocBlockSchema.model.flavour,
              {
                xywh: model.xywh,
                style: "syncedDoc",
                pageId: linkedDoc.id,
                index: model.index,
              },
              surfaceId,
            );

            ctx.track("CanvasElementAdded", {
              control: "context-menu",
              type: "embed-synced-doc",
            });
            ctx.track("DocCreated", {
              control: "turn into linked doc",
              type: "embed-linked-doc",
            });
            ctx.track("LinkedDocCreated", {
              control: "turn into linked doc",
              type: "embed-linked-doc",
              other: "new doc",
            });

            moveConnectors(model.id, cardId, ctx.std);

            // Deletes selected note
            ctx.store.transact(() => {
              ctx.store.deleteBlock(model);
            });
            ctx.gfx.selection.set({
              elements: [cardId],
              editing: false,
            });
          };

          create().catch(console.error);
        },
      },
      {
        id: "b.create-linked-doc",
        disabled: (ctx) =>
          ctx.store.readonly ||
          ctx
            .getSurfaceModels()
            .some((model) => ctx.store.hasFixedText(model.id)),
        label: editorMessage(
          "com.myoxus.editor.toolbar.create-linked-doc",
          "Create linked doc",
        ),
        icon: "LinkedPageIcon",
        when(ctx) {
          const models = ctx.getSurfaceModels();
          if (models.length === 0) return false;
          if (models.length === 1) {
            return ![
              NoteBlockModel,
              EmbedLinkedDocModel,
              EmbedSyncedDocModel,
            ].some((k) => ctx.matchModel(models[0], k));
          }
          return true;
        },
        run(ctx) {
          const models = ctx.getSurfaceModels();
          if (!models.length) return;
          if (
            ctx.store.readonly ||
            models.some((model) => ctx.store.hasFixedText(model.id))
          )
            return;

          const create = async () => {
            const edgeless = getEdgelessWith(ctx);
            if (!edgeless) return;

            const surfaceId = edgeless.surfaceBlockModel.id;
            if (!surfaceId) return;

            const title = await promptDocTitle(ctx.std);
            if (title === null) return;
            if (
              ctx.store.readonly ||
              models.some((model) => ctx.store.hasFixedText(model.id))
            )
              return;

            const clonedModels = getSortedCloneElements(models);
            const linkedDoc = createLinkedDocFromEdgelessElements(
              ctx.host,
              clonedModels,
              title,
            );

            ctx.store.transact(() => {
              deleteElements(edgeless, clonedModels);
            });

            // Inserts linked doc card
            const width = 364;
            const height = 390;
            const bound = getCommonBoundWithRotation(clonedModels);
            const cardId = ctx.std.get(EdgelessCRUDIdentifier).addBlock(
              EmbedLinkedDocBlockSchema.model.flavour,
              {
                xywh: `[${bound.center[0] - width / 2}, ${bound.center[1] - height / 2}, ${width}, ${height}]`,
                style: "vertical",
                pageId: linkedDoc.id,
              },
              surfaceId,
            );

            ctx.gfx.selection.set({
              elements: [cardId],
              editing: false,
            });

            ctx.track("CanvasElementAdded", {
              control: "context-menu",
              type: "embed-linked-doc",
            });
            ctx.track("DocCreated", {
              control: "create linked doc",
              type: "embed-linked-doc",
            });
            ctx.track("LinkedDocCreated", {
              control: "create linked doc",
              type: "embed-linked-doc",
              other: "new doc",
            });

            notifyDocCreated(ctx.std);
          };

          create().catch(console.error);
        },
      },
    ],
  },

  // Deleting Group
  {
    id: "e.delete",
    label: editorMessage("Delete", "Delete"),
    icon: "DeleteIcon",
    variant: "destructive",
    run(ctx) {
      const models = ctx.getSurfaceModels();
      if (!models.length) return;

      const edgeless = getEdgelessWith(ctx);
      if (!edgeless) return;

      ctx.store.captureSync();

      deleteElements(edgeless, models);

      // Clears
      ctx.select("surface");
      ctx.reset();
    },
  },
] as const satisfies ToolbarActions;

function reorderElements(
  ctx: ToolbarContext,
  models: GfxModel[],
  type: ReorderingType,
) {
  if (!models.length) return;

  for (const model of models) {
    const index = ctx.gfx.layer.getReorderedIndex(model, type);

    // block should be updated in transaction
    if (model instanceof GfxBlockElementModel) {
      ctx.store.transact(() => {
        model.index = index;
      });
    } else {
      model.index = index;
    }
  }
}

function isRefreshableModel(model: GfxModel) {
  return (
    model instanceof AttachmentBlockModel ||
    model instanceof BookmarkBlockModel ||
    model instanceof ImageBlockModel ||
    isExternalEmbedModel(model)
  );
}

function isRefreshableBlock(block: BlockComponent | null) {
  return (
    !!block &&
    (block instanceof AttachmentBlockComponent ||
      block instanceof BookmarkBlockComponent ||
      block instanceof ImageBlockComponent ||
      isExternalEmbedBlockComponent(block))
  );
}
