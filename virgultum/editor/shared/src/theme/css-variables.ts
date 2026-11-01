/* CSS variables. You need to handle all places where `CSS variables` are marked. */

import {
  type MyoxusCssVariables,
  type MyoxusTheme,
  cssVar,
} from "@myoxus/theme";
import { LINE_COLORS } from "@virgultum/model";
export { cssVar } from "@myoxus/theme";
import { unsafeCSS } from "lit";
export const ColorVariables = [
  "--myoxus-brand-color",
  "--myoxus-primary-color",
  "--myoxus-secondary-color",
  "--myoxus-tertiary-color",
  "--myoxus-hover-color",
  "--myoxus-icon-color",
  "--myoxus-icon-secondary",
  "--myoxus-border-color",
  "--myoxus-divider-color",
  "--myoxus-placeholder-color",
  "--myoxus-quote-color",
  "--myoxus-link-color",
  "--myoxus-edgeless-grid-color",
  "--myoxus-success-color",
  "--myoxus-warning-color",
  "--myoxus-error-color",
  "--myoxus-processing-color",
  "--myoxus-text-emphasis-color",
  "--myoxus-text-primary-color",
  "--myoxus-text-secondary-color",
  "--myoxus-text-disable-color",
  "--myoxus-black-10",
  "--myoxus-black-30",
  "--myoxus-black-50",
  "--myoxus-black-60",
  "--myoxus-black-80",
  "--myoxus-black-90",
  "--myoxus-black",
  "--myoxus-white-10",
  "--myoxus-white-30",
  "--myoxus-white-50",
  "--myoxus-white-60",
  "--myoxus-white-80",
  "--myoxus-white-90",
  "--myoxus-white",
  "--myoxus-background-code-block",
  "--myoxus-background-tertiary-color",
  "--myoxus-background-processing-color",
  "--myoxus-background-error-color",
  "--myoxus-background-warning-color",
  "--myoxus-background-success-color",
  "--myoxus-background-primary-color",
  "--myoxus-background-secondary-color",
  "--myoxus-background-modal-color",
  "--myoxus-background-overlay-panel-color",
  "--myoxus-tag-blue",
  "--myoxus-tag-green",
  "--myoxus-tag-teal",
  "--myoxus-tag-white",
  "--myoxus-tag-purple",
  "--myoxus-tag-red",
  "--myoxus-tag-pink",
  "--myoxus-tag-yellow",
  "--myoxus-tag-orange",
  "--myoxus-tag-gray",
  ...LINE_COLORS,
  "--myoxus-tooltip",
  "--myoxus-blue",
];

export const SizeVariables = [
  "--myoxus-font-h-1",
  "--myoxus-font-h-2",
  "--myoxus-font-h-3",
  "--myoxus-font-h-4",
  "--myoxus-font-h-5",
  "--myoxus-font-h-6",
  "--myoxus-font-base",
  "--myoxus-font-sm",
  "--myoxus-font-xs",
  "--myoxus-line-height",
  "--myoxus-z-index-modal",
  "--myoxus-z-index-popover",
];

export const FontFamilyVariables = [
  "--myoxus-font-family",
  "--myoxus-font-number-family",
  "--myoxus-font-code-family",
];

export const StyleVariables = [
  "--myoxus-editor-width",

  "--myoxus-theme-mode",
  "--myoxus-editor-mode",
  /* --myoxus-palette-transparent: special values added for the sake of logical consistency. */
  "--myoxus-palette-transparent",

  "--myoxus-popover-shadow",
  "--myoxus-menu-shadow",
  "--myoxus-float-button-shadow",
  "--myoxus-shadow-1",
  "--myoxus-shadow-2",
  "--myoxus-shadow-3",

  "--myoxus-paragraph-space",
  "--myoxus-popover-radius",
  "--myoxus-scale",
  ...SizeVariables,
  ...ColorVariables,
  ...FontFamilyVariables,
] as const;

type VariablesType = typeof StyleVariables;
export type CssVariableName = Extract<
  VariablesType[keyof VariablesType],
  string
>;

export type CssVariablesMap = Record<CssVariableName, string>;

export const unsafeCSSVar = (
  key: keyof MyoxusCssVariables | keyof MyoxusTheme,
  fallback?: string,
) => unsafeCSS(cssVar(key, fallback));

/**
 * Marks a complete, caller-owned CSS value as static Lit CSS.
 *
 * This is a renderer adapter, not a design-token lookup. Product chrome should
 * source its values from Mantine variables or the server-owned theme before
 * crossing this boundary.
 */
export const unsafeCSSValue = (value: string) => unsafeCSS(value);
