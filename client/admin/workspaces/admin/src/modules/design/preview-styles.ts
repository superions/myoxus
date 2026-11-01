import type { CSSProperties } from "react";

import {
  styleByKey,
  type ColorTokenKey,
  type ThemeDefinition,
} from "../theme/theme-contract";
import { typographyThemeStylePreviewStyle } from "../typography/preview-styles";

/** Keep catalog and draft samples on the typography of the previewed theme. */
export function designTypographyPreviewStyle(
  theme: ThemeDefinition | null | undefined,
): CSSProperties {
  return Object.assign(
    {},
    ...(
      [
        ["heading.h2", "h2"],
        ["body.default", "body"],
        ["link.default", "link"],
        ["code.block", "code-block"],
      ] as const
    ).map(([key, prefix]) => {
      const style = styleByKey(
        theme,
        key === "heading.h2" ? [key, "section.title"] : [key],
      );
      return style ? typographyThemeStylePreviewStyle(style, prefix) : {};
    }),
  );
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export type DesignColorPreviewStyle = CSSProperties &
  Record<`--authoring-color-${string}`, string>;

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function previewColor(value: string | undefined, fallback: string): string {
  return value && HEX_COLOR_PATTERN.test(value.trim())
    ? normalizeHex(value)
    : fallback;
}

/**
 * Maps the editable color draft into the facade-owned AuthoringColorPreview
 * CSS contract. These dynamic variables are part of the preview feature:
 * removing them would make the color editor stop showing the values being
 * authored.
 */
export function designColorPreviewStyle(
  colors: Record<ColorTokenKey, string>,
): DesignColorPreviewStyle {
  return {
    "--authoring-color-paper": previewColor(
      colors.paper,
      "var(--myoxus-background-primary-color)",
    ),
    "--authoring-color-paper-deep": previewColor(
      colors["paper-deep"],
      "var(--myoxus-background-secondary-color)",
    ),
    "--authoring-color-background-code-block": previewColor(
      colors["background-code-block"],
      "var(--myoxus-background-code-block)",
    ),
    "--authoring-color-ink": previewColor(
      colors.ink,
      "var(--myoxus-text-primary-color)",
    ),
    "--authoring-color-ink-soft": previewColor(
      colors["ink-soft"],
      "var(--myoxus-text-secondary-color)",
    ),
    "--authoring-color-rule": previewColor(
      colors.rule,
      "var(--myoxus-border-color)",
    ),
    "--authoring-color-link": previewColor(
      colors["link-default"],
      "var(--myoxus-link-color)",
    ),
    "--authoring-color-accent-primary": previewColor(
      colors["accent-primary"],
      "var(--myoxus-primary-color)",
    ),
  } as DesignColorPreviewStyle;
}
