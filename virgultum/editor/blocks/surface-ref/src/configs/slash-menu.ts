import { EdgelessFrameManagerIdentifier } from "@virgultum/block-frame";
import { EdgelessCRUDExtension } from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import {
  SurfaceRefBlockSchema,
  MermaidBlockModel,
  MermaidBlockSchema,
} from "@virgultum/model";
import { BlockSelection } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { editorMessage } from "@virgultum/shared/services";
import {
  type SlashMenuActionItem,
  type SlashMenuConfig,
  SlashMenuConfigExtension,
  type SlashMenuItem,
} from "@virgultum/widget-slash-menu";

import { insertSurfaceRefBlockCommand } from "../commands";

function encodeSlashReferenceId(value: string) {
  return Array.from(value, (character) =>
    character.codePointAt(0)!.toString(16),
  ).join("-");
}

const surfaceRefSlashMenuConfig: SlashMenuConfig = {
  items: ({ std, model }) => {
    const crud = std.get(EdgelessCRUDExtension);
    const frameMgr = std.get(EdgelessFrameManagerIdentifier);

    const findSpace = (bound: Bound, padding = 20) => {
      const gfx = std.get(GfxControllerIdentifier);
      let elementInFrameBound = gfx.grid.search(bound);
      while (elementInFrameBound.length > 0) {
        const rightElement = elementInFrameBound.reduce((a, b) => {
          return a.x + a.w > b.x + b.w ? a : b;
        });
        bound.x = rightElement.x + rightElement.w + padding;
        elementInFrameBound = gfx.grid.search(bound);
      }
      return bound;
    };

    const insertSurfaceRefAndSelect = (reference: string) => {
      const [_, result] = std.command.exec(insertSurfaceRefBlockCommand, {
        reference,
        place: "after",
        removeEmptyLine: true,
        selectedModels: [model],
      });
      if (!result.insertedSurfaceRefBlockId) return;

      std.selection.set([
        std.selection.create(BlockSelection, {
          blockId: result.insertedSurfaceRefBlockId,
        }),
      ]);
    };

    let index = 0;

    const insertBlankFrameItem: SlashMenuItem = {
      id: "surface-frame-insert",
      label: editorMessage("com.myoxus.editor.slash.frame", "Frame"),
      description: editorMessage(
        "com.myoxus.editor.slash.frame-description",
        "Insert a blank frame",
      ),
      icon: "FrameIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.frame", "Frame"),
      },
      group: {
        id: "edgeless-element",
        label: editorMessage(
          "com.myoxus.editor.group.edgeless-element",
          "Edgeless Element",
        ),
        order: 5,
        itemOrder: index++,
      },
      action: () => {
        const frameBound = findSpace(Bound.fromXYWH([0, 0, 1600, 900]));
        const frame = frameMgr.createFrameOnBound(frameBound);
        insertSurfaceRefAndSelect(frame.id);
      },
    };

    const frameItems = frameMgr.frames.map<SlashMenuActionItem>(
      (frameModel) => ({
        id: `surface-frame-${encodeSlashReferenceId(frameModel.id)}`,
        label: editorMessage(
          "com.myoxus.editor.slash.frame-reference",
          "Frame: {{title}}",
          { title: frameModel.props.title.toString() },
        ),
        icon: "FrameIcon",
        group: {
          id: "edgeless-element",
          label: editorMessage(
            "com.myoxus.editor.group.edgeless-element",
            "Edgeless Element",
          ),
          order: 5,
          itemOrder: index++,
        },
        tooltip: {
          caption: editorMessage(
            "com.myoxus.editor.slash.edgeless",
            "Edgeless",
          ),
        },
        action: () => {
          insertSurfaceRefAndSelect(frameModel.id);
        },
      }),
    );

    const groupElements = crud.getElementsByType("group");
    const groupItems = groupElements.map<SlashMenuActionItem>((group) => ({
      id: `surface-group-${encodeSlashReferenceId(group.id)}`,
      label: editorMessage(
        "com.myoxus.editor.slash.group-reference",
        "Group: {{title}}",
        { title: group.title.toString() },
      ),
      icon: "GroupingIcon",
      group: {
        id: "edgeless-element",
        label: editorMessage(
          "com.myoxus.editor.group.edgeless-element",
          "Edgeless Element",
        ),
        order: 5,
        itemOrder: index++,
      },
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.edgeless", "Edgeless"),
      },
      action: () => {
        insertSurfaceRefAndSelect(group.id);
      },
    }));

    const diagramItems = std.store
      .getBlocksByFlavour(MermaidBlockSchema.model.flavour)
      .map((block) => block.model)
      .filter(
        (owner): owner is MermaidBlockModel =>
          owner instanceof MermaidBlockModel &&
          std.store.getParent(owner)?.flavour === "myoxus:surface",
      )
      .map<SlashMenuActionItem>((owner) => ({
        id: `surface-diagram-${encodeSlashReferenceId(owner.id)}`,
        label: editorMessage(
          "com.myoxus.editor.mermaid.export-label",
          "Mermaid diagram: {{title}}",
          { title: owner.props.title.toString() || "Mermaid" },
        ),
        icon: "WorkflowIcon",
        group: {
          id: "edgeless-element",
          label: editorMessage(
            "com.myoxus.editor.group.edgeless-element",
            "Edgeless Element",
          ),
          order: 5,
          itemOrder: index++,
        },
        action: () => insertSurfaceRefAndSelect(owner.id),
      }));
    return [
      insertBlankFrameItem,
      ...frameItems,
      ...groupItems,
      ...diagramItems,
    ];
  },
};

export const SurfaceRefSlashMenuConfigExtension = SlashMenuConfigExtension(
  SurfaceRefBlockSchema.model.flavour,
  surfaceRefSlashMenuConfig,
);
