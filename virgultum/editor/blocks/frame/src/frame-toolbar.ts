import {
  createToolbarColorControl,
  editorMessage,
  resolveEditorMessage,
  EditorI18nProvider,
  NotificationProvider,
  type ToolbarContext,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { packColor } from "@virgultum/components/color-picker";
import { Bound } from "@virgultum/global/gfx";
import {
  DEFAULT_NOTE_HEIGHT,
  DefaultTheme,
  FrameBlockModel,
  FrameBlockSchema,
  NoteBlockModel,
  NoteBlockSchema,
  NoteDisplayMode,
  resolveColor,
  SurfaceRefBlockSchema,
} from "@virgultum/model";

import {
  editorToast,
  getMostCommonResolvedValue,
  matchModels,
} from "@virgultum/shared/utils";

import { type BlockComponent, BlockFlavourIdentifier } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { ExtensionType } from "@virgultum/store";
import { mountFrameTitleEditor } from "@virgultum/widget-frame-title";

import { EdgelessFrameManagerIdentifier } from "./frame-manager";

function getRootBlock(ctx: ToolbarContext): BlockComponent | null {
  const rootModel = ctx.store.root;
  if (!rootModel) return null;

  return ctx.view.getBlock(rootModel.id);
}

const builtinSurfaceToolbarConfig = {
  actions: [
    {
      id: "a.insert-into-page",
      label: editorMessage(
        "com.myoxus.editor.toolbar.insert-into-page",
        "Insert into Page",
      ),
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.insert-into-page",
        "Insert into Page",
      ),
      icon: "InsertIntoPageIcon",
      when: (ctx) => ctx.getSurfaceModelsByType(FrameBlockModel).length === 1,
      run(ctx) {
        const model = ctx.getCurrentModelByType(FrameBlockModel);
        if (!model) return;

        const rootModel = ctx.store.root;
        if (!rootModel) return;

        const { id: frameId, xywh } = model;
        let lastNoteId = rootModel.children.findLast(
          (note) =>
            matchModels(note, [NoteBlockModel]) &&
            note.props.displayMode !== NoteDisplayMode.EdgelessOnly,
        )?.id;

        if (!lastNoteId) {
          const bounds = Bound.deserialize(xywh);
          bounds.y += bounds.h;
          bounds.h = DEFAULT_NOTE_HEIGHT;

          lastNoteId = ctx.store.addBlock(
            NoteBlockSchema.model.flavour,
            { xywh: bounds.serialize() },
            rootModel.id,
          );
        }

        ctx.store.captureSync();
        ctx.store.addBlock(
          SurfaceRefBlockSchema.model.flavour,
          { reference: frameId, refFlavour: FrameBlockSchema.model.flavour },
          lastNoteId,
        );

        const notification = ctx.std.getOptional(NotificationProvider);
        if (notification) {
          notification.notifyWithUndoAction({
            title: resolveEditorMessage(
              editorMessage(
                "com.myoxus.editor.frame.inserted-title",
                "Frame inserted into Page.",
              ),
              ctx.std.getOptional(EditorI18nProvider) ?? undefined,
            ),
            message: resolveEditorMessage(
              editorMessage(
                "com.myoxus.editor.frame.inserted-message",
                "Frame has been inserted into doc",
              ),
              ctx.std.getOptional(EditorI18nProvider) ?? undefined,
            ),
            accent: "success",
          });
        } else {
          editorToast(
            ctx.host,
            editorMessage(
              "com.myoxus.editor.frame.inserted-message",
              "Frame has been inserted into doc",
            ),
          );
        }
      },
    },
    {
      id: "b.rename",
      tooltip: editorMessage("Rename", "Rename"),
      icon: "EditIcon",
      when: (ctx) => ctx.getSurfaceModelsByType(FrameBlockModel).length === 1,
      run(ctx) {
        const model = ctx.getCurrentModelByType(FrameBlockModel);
        if (!model) return;

        const rootBlock = getRootBlock(ctx);
        if (!rootBlock) return;

        mountFrameTitleEditor(model, rootBlock);
      },
    },
    {
      id: "b.ungroup",
      tooltip: editorMessage("com.myoxus.keyboardShortcuts.unGroup", "Ungroup"),
      icon: "UngroupIcon",
      run(ctx) {
        const models = ctx.getSurfaceModelsByType(FrameBlockModel);
        if (!models.length) return;

        const crud = ctx.std.get(EdgelessCRUDIdentifier);
        const gfx = ctx.std.get(GfxControllerIdentifier);

        ctx.store.captureSync();

        const frameManager = ctx.std.get(EdgelessFrameManagerIdentifier);

        for (const model of models) {
          frameManager.removeAllChildrenFromFrame(model);
        }

        for (const model of models) {
          crud.removeElement(model.id);
        }

        gfx.selection.clear();
      },
    },
    {
      id: "c.color-picker",
      label: editorMessage(
        "com.myoxus.editor.keyboard.background",
        "Background",
      ),
      control(ctx) {
        const models = ctx.getSurfaceModelsByType(FrameBlockModel);
        if (!models.length) return null;
        const theme = ctx.theme.edgeless$.value;
        const field = "background";
        const value =
          getMostCommonResolvedValue(
            models.map((model) => model.props),
            field,
            (color) => resolveColor(color, theme),
          ) ?? DefaultTheme.transparent;
        return createToolbarColorControl({
          value,
          theme,
          change: (color) => {
            const props = packColor(field, color);
            const crud = ctx.std.get(EdgelessCRUDIdentifier);
            models.forEach((model) => crud.updateElement(model.id, props));
          },
          start: () => {
            ctx.store.captureSync();
            models.forEach((model) => model.stash(field));
            return () =>
              ctx.store.transact(() =>
                models.forEach((model) => model.pop(field)),
              );
          },
        });
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(FrameBlockModel).length > 0,
} as const satisfies ToolbarModuleConfig;

const createFrameToolbarConfig = (flavour: string): ExtensionType => {
  const name = flavour.split(":").pop();

  return ToolbarModuleExtension({
    id: BlockFlavourIdentifier(`myoxus:surface:${name}`),
    config: builtinSurfaceToolbarConfig,
  });
};

export const frameToolbarExtension = createFrameToolbarConfig(
  FrameBlockSchema.model.flavour,
);
