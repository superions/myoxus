import { type EditorI18nMessage } from "@virgultum/shared/services";
import type { MenuConfig } from "@virgultum/components/context-menu";
import type { BlockComponent } from "@virgultum/std";
import type { GfxController } from "@virgultum/std/gfx";
import type { TemplateResult } from "lit";

export type MenuItem<T> = {
  key?: string | EditorI18nMessage;
  value: T;
  icon?: TemplateResult;
  disabled?: boolean;
};

export type Menu<T> = {
  label: string | EditorI18nMessage;
  icon?: TemplateResult;
  tooltip?: string | EditorI18nMessage;
  items: MenuItem<T>[];
  currentValue: T;
  onPick: (value: T) => void;
};

/**
 * Helper function to build a menu configuration for a tool in dense mode
 */
export type DenseMenuBuilder = (
  edgeless: BlockComponent,
  gfx: GfxController,
) => MenuConfig;
