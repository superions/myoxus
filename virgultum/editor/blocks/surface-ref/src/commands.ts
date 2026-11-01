import { EdgelessCRUDExtension } from "@virgultum/block-surface";
import { type SurfaceRefProps } from "@virgultum/model";
import type { Command } from "@virgultum/std";
import { GfxPrimitiveElementModel } from "@virgultum/std/gfx";
import type { BlockModel } from "@virgultum/store";

export const insertSurfaceRefBlockCommand: Command<
  {
    reference: string;
    place: "after" | "before";
    removeEmptyLine?: boolean;
    selectedModels?: BlockModel[];
  },
  {
    insertedSurfaceRefBlockId: string;
  }
> = (ctx, next) => {
  const { selectedModels, reference, place, removeEmptyLine, std } = ctx;
  if (!selectedModels?.length) return;

  const targetModel =
    place === "before"
      ? selectedModels[0]
      : selectedModels[selectedModels.length - 1];

  const surfaceRefProps: Partial<SurfaceRefProps> & {
    flavour: "myoxus:surface-ref";
  } = {
    flavour: "myoxus:surface-ref",
    reference,
    pageId: std.store.id,
    workspaceId: std.workspace.id,
  };

  const crud = std.get(EdgelessCRUDExtension);
  const element = crud.getElementById(reference);

  if (!element) {
    console.error(`reference not found ${reference}`);
    return;
  }

  surfaceRefProps.refFlavour =
    element instanceof GfxPrimitiveElementModel
      ? element.type
      : element.flavour;

  const result = std.store.addSiblingBlocks(
    targetModel,
    [surfaceRefProps],
    place,
  );
  if (result.length === 0) return;

  if (removeEmptyLine && targetModel.text?.length === 0) {
    std.store.deleteBlock(targetModel);
  }

  next({
    insertedSurfaceRefBlockId: result[0],
  });
};
