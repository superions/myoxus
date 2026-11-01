import type { CSSProperties } from "react";

import type { ThemeTypographyStyle } from "../theme/theme-contract";
import {
  type BlockquoteToken,
  type BodyToken,
  type HierarchyToken,
  type LinkToken,
  type MonoToken,
  typographyFontFamilyCss,
  type TypographyTokens,
} from "./api";

export type TypographyPreviewStyle = CSSProperties &
  Record<`--authoring-typography-${string}`, string | number>;

type TextPreviewToken = HierarchyToken | BodyToken;

function textPreviewStyle(
  token: TextPreviewToken,
  prefix = "body",
): TypographyPreviewStyle {
  return {
    ...(token.sourceStyle
      ? themeStylePreviewStyle(token.sourceStyle, prefix)
      : {}),
    [`--authoring-typography-${prefix}-family`]: typographyFontFamilyCss(token),
    [`--authoring-typography-${prefix}-weight`]: token.weight,
    [`--authoring-typography-${prefix}-size`]: `${token.size}px`,
    [`--authoring-typography-${prefix}-line-height`]: token.lineHeight,
    [`--authoring-typography-${prefix}-letter-spacing`]: `${token.letterSpacing}em`,
  } as TypographyPreviewStyle;
}

function fontSettings(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "normal";
  const settings = Object.entries(value).flatMap(([tag, setting]) => {
    if (!/^[a-zA-Z0-9]{4}$/.test(tag)) return [];
    const number = typeof setting === "boolean" ? Number(setting) : setting;
    return typeof number === "number" && Number.isFinite(number)
      ? [`"${tag}" ${number}`]
      : [];
  });
  return settings.join(", ") || "normal";
}

function themeStylePreviewStyle(
  style: ThemeTypographyStyle,
  prefix = "body",
): TypographyPreviewStyle {
  return {
    [`--authoring-typography-${prefix}-family`]: typographyFontFamilyCss({
      family: style.fontFamily,
      cssFamily: style.cssFamily ?? undefined,
    }),
    [`--authoring-typography-${prefix}-weight`]: style.fontWeight,
    [`--authoring-typography-${prefix}-size`]: style.sizePx
      ? `${style.sizePx}px`
      : "var(--mantine-font-size-body, var(--mantine-font-size-md))",
    [`--authoring-typography-${prefix}-line-height`]:
      style.lineHeight ??
      "var(--mantine-line-height-body, var(--mantine-line-height-md))",
    [`--authoring-typography-${prefix}-letter-spacing`]:
      typeof style.letterSpacingEm === "number"
        ? `${style.letterSpacingEm}em`
        : "var(--mantine-letter-spacing-body, 0em)",
    [`--authoring-typography-${prefix}-features`]: fontSettings(
      style.fontFeatures,
    ),
    [`--authoring-typography-${prefix}-variations`]: fontSettings(
      style.fontVariations,
    ),
    [`--authoring-typography-${prefix}-style`]: style.fontStyle ?? "normal",
    [`--authoring-typography-${prefix}-decoration`]: style.decoration ?? "none",
    [`--authoring-typography-${prefix}-hover-decoration`]:
      style.hoverDecoration ?? style.decoration ?? "none",
    [`--authoring-typography-${prefix}-transform`]:
      style.textTransform ?? "none",
  } as TypographyPreviewStyle;
}

export function typographyTextPreviewStyle(
  token: TextPreviewToken,
): TypographyPreviewStyle {
  return textPreviewStyle(token);
}

export function typographyQuotePreviewStyle(
  token: BlockquoteToken,
): TypographyPreviewStyle {
  return {
    "--authoring-typography-blockquote-family": typographyFontFamilyCss(
      token,
      "serif",
    ),
    "--authoring-typography-blockquote-weight": token.weight,
    "--authoring-typography-blockquote-size": `${token.size}px`,
    "--authoring-typography-blockquote-line-height": token.lineHeight,
    "--authoring-typography-blockquote-style": token.fontStyle,
  } as TypographyPreviewStyle;
}

export function typographyLinkPreviewStyle(
  token: LinkToken,
  decoration: LinkToken["decoration"] | LinkToken["hoverDecoration"],
): TypographyPreviewStyle {
  return {
    ...(token.sourceStyle
      ? themeStylePreviewStyle(token.sourceStyle, "link")
      : {}),
    "--authoring-typography-link-hover-decoration": token.hoverDecoration,
    "--authoring-typography-link-family": typographyFontFamilyCss(token),
    "--authoring-typography-link-weight": token.weight,
    "--authoring-typography-link-decoration": decoration,
  } as TypographyPreviewStyle;
}

export function typographyMonoPreviewStyle(
  token: MonoToken,
  prefix = "mono",
): TypographyPreviewStyle {
  return {
    [`--authoring-typography-${prefix}-family`]: typographyFontFamilyCss(
      token,
      "monospace",
    ),
    [`--authoring-typography-${prefix}-weight`]: token.weight,
    [`--authoring-typography-${prefix}-size`]: `${token.size}px`,
  } as TypographyPreviewStyle;
}

export function typographyCatalogStylePreviewStyle(
  style: ThemeTypographyStyle,
): TypographyPreviewStyle {
  return themeStylePreviewStyle(style);
}

export function typographyThemeStylePreviewStyle(
  style: ThemeTypographyStyle,
  prefix = "body",
): TypographyPreviewStyle {
  return themeStylePreviewStyle(style, prefix);
}

export function typographyFullPreviewStyle(
  tokens: TypographyTokens,
): TypographyPreviewStyle {
  return {
    ...textPreviewStyle(tokens.h1, "h1"),
    ...textPreviewStyle(tokens.h2, "h2"),
    ...textPreviewStyle(tokens.h3, "h3"),
    ...textPreviewStyle(tokens.h4, "h4"),
    ...textPreviewStyle(tokens.h5, "h5"),
    ...textPreviewStyle(tokens.body),
    ...textPreviewStyle(tokens.bodySmall, "body-small"),
    ...typographyLinkPreviewStyle(tokens.link, tokens.link.decoration),
    ...typographyQuotePreviewStyle(tokens.blockquote),
    ...typographyMonoPreviewStyle(tokens.mono),
  };
}
