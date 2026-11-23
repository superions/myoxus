import type {
  EditorCanvasToolbarItem,
  EditorI18nMessage,
  SelectionAction,
} from "@virgultum/core/services";
import { createIdentifier } from "@virgultum/core/primitives/di";
import type { BlockComponent } from "@virgultum/core/runtime";
import type { GfxController } from "@virgultum/core/runtime/gfx";
import type { ExtensionType } from "@virgultum/core/store";

export interface QuickTool {
  type?: string;
  enable?: boolean;
  content: EditorCanvasToolbarItem;
  /**
   * if not configured, the tool will not be shown in dense mode
   */
  menu?: SelectionAction;
  priority?: number;
}

export interface SeniorTool {
  /**
   * Used to show in nav-button's tooltip
   */
  name: string | EditorI18nMessage;
  content: EditorCanvasToolbarItem;
  enable?: boolean;
}

export type ToolBuilder<T> = (options: {
  block: BlockComponent;
  gfx: GfxController;
  toolbarContainer: HTMLElement;
}) => T;

export const QuickToolIdentifier = createIdentifier<ToolBuilder<QuickTool>>(
  "edgeless-quick-tool",
);
export const SeniorToolIdentifier = createIdentifier<ToolBuilder<SeniorTool>>(
  "edgeless-senior-tool",
);

export const QuickToolExtension = (
  id: string,
  builder: ToolBuilder<QuickTool>,
): ExtensionType => {
  return {
    setup: (di) => {
      di.addImpl(QuickToolIdentifier(id), () => builder);
    },
  };
};

export const SeniorToolExtension = (
  id: string,
  builder: ToolBuilder<SeniorTool>,
): ExtensionType => {
  return {
    setup: (di) => {
      di.addImpl(SeniorToolIdentifier(id), () => builder);
    },
  };
};
