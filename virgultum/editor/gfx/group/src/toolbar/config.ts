import { Bound } from "@virgultum/global/gfx";
import {
  DEFAULT_NOTE_HEIGHT,
  GroupElementModel,
  NoteBlockModel,
  NoteBlockSchema,
  NoteDisplayMode,
  SurfaceRefBlockSchema,
} from "@virgultum/model";
import {
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
  editorMessage,
} from "@virgultum/shared/services";
import { editorToast, matchModels } from "@virgultum/shared/utils";

import { BlockFlavourIdentifier } from "@virgultum/std";
import { getRootBlock } from "@virgultum/widget-edgeless-toolbar";

import { ungroupCommand } from "../command";
import { mountGroupTitleEditor } from "../text/text";

export const groupToolbarConfig = {
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
      when: (ctx) => ctx.getSurfaceModelsByType(GroupElementModel).length === 1,
      run(ctx) {
        const model = ctx.getCurrentModelByType(GroupElementModel);
        if (!model) return;

        const rootModel = ctx.store.root;
        if (!rootModel) return;

        const { id: groupId, xywh } = model;
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

        ctx.store.addBlock(
          SurfaceRefBlockSchema.model.flavour,
          { reference: groupId, refFlavour: "group" },
          lastNoteId,
        );

        editorToast(
          ctx.host,
          editorMessage(
            "com.myoxus.editor.group.inserted",
            "Group has been inserted into doc",
          ),
        );
      },
    },
    {
      id: "b.rename",
      tooltip: editorMessage("Rename", "Rename"),
      icon: "EditIcon",
      when: (ctx) => ctx.getSurfaceModelsByType(GroupElementModel).length === 1,
      run(ctx) {
        const model = ctx.getCurrentModelByType(GroupElementModel);
        if (!model) return;

        const rootBlock = getRootBlock(ctx);
        if (!rootBlock) return;

        mountGroupTitleEditor(model, rootBlock);
      },
    },
    {
      id: "b.ungroup",
      tooltip: editorMessage("com.myoxus.keyboardShortcuts.unGroup", "Ungroup"),
      icon: "UngroupIcon",
      run(ctx) {
        const models = ctx.getSurfaceModelsByType(GroupElementModel);
        if (!models.length) return;

        for (const model of models) {
          ctx.command.exec(ungroupCommand, { group: model });
        }
      },
    },
  ],

  when: (ctx) => ctx.getSurfaceModelsByType(GroupElementModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const groupToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:group"),
  config: groupToolbarConfig,
});
