import type { Command } from "../../runtime/index";
import type { BlockModel } from "../../store/index";

export const retainFirstModelCommand: Command<{
  selectedModels?: BlockModel[];
}> = (ctx, next) => {
  if (!ctx.selectedModels) {
    console.error(
      "`selectedModels` is required, you need to use `getSelectedModels` command before adding this command to the pipeline.",
    );
    return;
  }

  if (ctx.selectedModels.length > 0) {
    ctx.selectedModels.shift();
  }

  return next();
};
