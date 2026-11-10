import type { Command } from "@virgultum/std";
import type { BlockModel } from "@virgultum/store";

import { getCompoundMutationBlockedFlavours } from "./compound-block-guards.js";

export const deleteSelectedModelsCommand: Command<{
  selectedModels?: BlockModel[];
}> = (ctx, next) => {
  const models = ctx.selectedModels;

  if (!models) {
    console.error(
      "`selectedModels` is required, you need to use `getSelectedModels` command before adding this command to the pipeline.",
    );
    return;
  }

  const blockedFlavours = getCompoundMutationBlockedFlavours(models);
  if (models.some((model) => ctx.std.store.hasFixedText(model))) return;
  if (blockedFlavours.length) {
    console.warn(
      `[model-crud] generic delete blocked for compound block(s): ${blockedFlavours.join(", ")}. Use the block-specific command so owned data is handled atomically.`,
    );
    return;
  }

  models.forEach((model) => {
    ctx.std.store.deleteBlock(model);
  });

  return next();
};
