import type { EditorI18nMessage } from "@virgultum/shared/services";
import type { MenuConfig } from "@virgultum/components/context-menu";
import { createIdentifier } from "@virgultum/global/di";
import type { BlockComponent } from "@virgultum/std";
import type { GfxController } from "@virgultum/std/gfx";
import type { ExtensionType } from "@virgultum/store";
import { type TemplateResult } from "lit";

export interface QuickTool {
  type?: string;
  enable?: boolean;
  content: TemplateResult;
  /**
   * if not configured, the tool will not be shown in dense mode
   */
  menu?: MenuConfig;
  priority?: number;
}

export interface SeniorTool {
  /**
   * Used to show in nav-button's tooltip
   */
  name: string | EditorI18nMessage;
  content: TemplateResult;
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
