import type { ToolbarContext } from "@virgultum/core/services";
import type { BlockComponent } from "@virgultum/core/runtime";

export function getRootBlock(ctx: ToolbarContext): BlockComponent | null {
  const rootModel = ctx.store.root;
  if (!rootModel) return null;

  return ctx.view.getBlock(rootModel.id);
}
