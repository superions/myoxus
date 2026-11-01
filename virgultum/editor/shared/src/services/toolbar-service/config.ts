import type { BlockStdScope } from "@virgultum/std";
import type { Placement } from "@floating-ui/dom";

import type { ToolbarActions } from "./action";
import type { ToolbarContext } from "./context";

export type ToolbarPlacement =
  Extract<Placement, "top" | "top-start"> | "inner";

export type ToolbarModuleConfig = {
  actions: ToolbarActions;

  when?: ((ctx: ToolbarContext) => boolean) | boolean;

  placement?: ToolbarPlacement;

  /**
   * Lets a type-owned custom toolbar replace the generic flavour toolbar.
   * Cross-cutting surface actions remain available.
   */
  replaceBase?: boolean;

  /** Opt in for a read-only surface selection; the module must hide mutations. */
  readonlySelection?: (std: BlockStdScope) => boolean;

  /** Return only read/copy actions for an explicitly supported read-only text
   * or block selection. Other modules are excluded while this selection owns
   * the toolbar; ordinary editor activation and mutation rights stay unchanged.
   */
  readonlyTextSelection?: (std: BlockStdScope) => ToolbarActions | null;
};
