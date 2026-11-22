import type { DocMode } from "@virgultum/editor/model";
import {
  getBlockSelectionsCommand,
  getImageSelectionsCommand,
  getSelectedModelsCommand,
  getTextSelectionCommand,
} from "@virgultum/editor/shared/commands";
import { type EditorHost } from "@virgultum/editor/std";
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
} from "@virgultum/editor/std/gfx";
export const getSelectedNodes = (
  host: EditorHost | null,
  mode: DocMode = "page",
) => {
  const std = host?.std;
  const blockIds: string[] = [];
  const elementIds: string[] = [];
  const result = { blockIds, elementIds };

  if (!std) {
    return result;
  }

  if (mode === "edgeless") {
    const { selection } = std.get(GfxControllerIdentifier);

    for (const element of selection.selectedElements) {
      if (element instanceof GfxBlockElementModel) {
        blockIds.push(element.id);
      } else {
        elementIds.push(element.id);
      }
    }

    return result;
  }

  const [success, ctx] = std.command
    .chain()
    .tryAll((chain) => [
      chain.pipe(getTextSelectionCommand),
      chain.pipe(getBlockSelectionsCommand),
      chain.pipe(getImageSelectionsCommand),
    ])
    .pipe(getSelectedModelsCommand, {
      mode: "highest",
    })
    .run();

  if (!success) {
    return result;
  }

  // should return an empty array if `to` of the range is null
  if (
    ctx.currentTextSelection &&
    !ctx.currentTextSelection.to &&
    ctx.currentTextSelection.from.length === 0
  ) {
    return result;
  }

  if (ctx.selectedModels?.length) {
    blockIds.push(...ctx.selectedModels.map((model) => model.id));
    return result;
  }

  return result;
};
