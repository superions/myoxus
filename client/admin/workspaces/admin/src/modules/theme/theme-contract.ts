// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

export type ThemeMode = "light" | "dark" | "system";
export type ColorMode = "light" | "dark";

export interface ThemeTypographyStyle {
  styleKey: string;
  fontFamilySlug?: string | null;
  fontFamily: string;
  cssFamily?: string | null;
  fontWeight: number;
  fontStyle?: string | null;
  sizePx?: number | null;
  lineHeight?: number | null;
  letterSpacingEm?: number | null;
  textTransform?: string | null;
  decoration?: string | null;
  hoverDecoration?: string | null;
  fontFeatures?: unknown;
  fontVariations?: unknown;
  pdfRole?: string | null;
}

export interface ThemeDefinition {
  slug: string;
  name: string;
  category?: string | null;
  previewGroup?: string | null;
  previewOrder?: number | null;
  taglineKey?: string | null;
  descriptionKey?: string | null;
  origin: string;
  locked: boolean;
  isDefault: boolean;
  colorSchemaSlug?: string | null;
  typographySlug?: string | null;
  colors: unknown;
  typographyStyles: ThemeTypographyStyle[];
}

export interface ThemeFontAsset {
  usage: string;
  format: string;
  style: string;
  weightMin: number;
  weightMax: number;
  weightDefault: number;
  assetKey: string;
  sha256: string;
  mime: string;
  unicodeRanges: string[];
  subsetTags: string[];
}

export interface ThemeFontFamily {
  slug: string;
  displayName: string;
  cssFamily: string;
  genericClass: string;
  source: string;
  licenseSpdx: string;
  licenseStatus: string;
  isSelectable: boolean;
  assets: ThemeFontAsset[];
}

export interface BrandAsset {
  id: string;
  slot: "logo" | "product_mark" | "favicon_pack" | string;
  variant: string;
  qualityClass: string;
  storageKind: string;
  storageKey: string;
  publicUrl?: string | null;
  mime: string;
  sha256: string;
  byteSize?: number | null;
  widthPx?: number | null;
  heightPx?: number | null;
}

export interface AppServerBranding {
  logo?: BrandAsset | null;
  productMark?: BrandAsset | null;
  faviconPack?: BrandAsset | null;
}

export interface ThemeProfile {
  scope: string;
  workspaceId?: string | null;
  themeMode: ThemeMode;
  theme: ThemeDefinition;
}

export type AppBrandAssetSlot =
  "logo_large" | "logo_small" | "product_mark" | "favicon_pack";

function normalizeSubPath(subPath: string | undefined): string {
  if (!subPath || subPath === "/") return "";
  return subPath.replace(/\/+$/, "");
}

export function resolveBrandingPublicUrl(
  path: string | null | undefined,
  subPath: string | undefined = globalThis.environment?.subPath,
): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("blob:")) {
    return trimmed;
  }
  if (/^(?:https?:|data:)/iu.test(trimmed)) return undefined;

  const prefix = normalizeSubPath(subPath);
  if (trimmed.startsWith("/")) {
    if (prefix && trimmed.startsWith(`${prefix}/`)) return trimmed;
    return `${prefix}${trimmed}`;
  }
  return `${prefix}/style/${trimmed}`;
}

export function getBrandingAssetPublicUrl(
  branding: AppServerBranding | null | undefined,
  assetType: AppBrandAssetSlot,
): string | undefined {
  const asset =
    assetType === "logo_large"
      ? branding?.logo
      : assetType === "product_mark"
        ? branding?.productMark
        : assetType === "favicon_pack"
          ? branding?.faviconPack
          : null;
  return resolveBrandingPublicUrl(asset?.publicUrl);
}

export const FAVICON_MANIFEST_SIZES = [32, 36, 48, 72, 96, 144, 192] as const;
export type FaviconManifestSize = (typeof FAVICON_MANIFEST_SIZES)[number];

export function faviconPublicUrlForSize(
  basePublicUrl: string | null | undefined,
  size: FaviconManifestSize,
): string | undefined {
  const resolved = resolveBrandingPublicUrl(basePublicUrl);
  if (!resolved) return undefined;

  const [pathPart, queryPart] = resolved.split("?", 2);
  const sizedPath = pathPart.replace(
    /favicon-\d+\.png$/u,
    `favicon-${size}.png`,
  );
  return queryPart ? `${sizedPath}?${queryPart}` : sizedPath;
}

export const COLOR_TOKEN_KEYS = [
  "paper",
  "paper-deep",
  "background-code-block",
  "ink",
  "ink-soft",
  "ink-mute",
  "rule",
  "accent-primary",
  "accent-secondary",
  "link-default",
  "status-success-paper",
  "status-success-deep",
  "status-pending-paper",
  "status-pending-deep",
  "status-error-paper",
  "status-error-deep",
  "status-preset-paper",
  "status-preset-deep",
  "status-info-paper",
  "status-info-deep",
] as const;

export type ColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];
export type ThemeColorTokens = Record<ColorTokenKey, string>;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isThemeMode(
  value: string | null | undefined,
): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveColorMode(
  themeMode: string | null | undefined,
): ColorMode {
  return themeMode === "dark" ? "dark" : "light";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getThemeColors(
  theme: ThemeDefinition | null | undefined,
  mode: ColorMode,
): ThemeColorTokens | null {
  if (!theme || !isRecord(theme.colors)) return null;
  const modeColors = theme.colors[mode];
  if (!isRecord(modeColors)) return null;

  const out: Partial<ThemeColorTokens> = {};
  for (const key of COLOR_TOKEN_KEYS) {
    const value = modeColors[key];
    if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value.trim())) {
      return null;
    }
    out[key] = value.trim();
  }
  return out as ThemeColorTokens;
}

export function getAllColorModes(theme: ThemeDefinition | null | undefined) {
  return {
    light: getThemeColors(theme, "light"),
    dark: getThemeColors(theme, "dark"),
  };
}

export function styleByKey(
  theme: ThemeDefinition | null | undefined,
  candidates: readonly string[],
): ThemeTypographyStyle | null {
  if (!theme) return null;
  for (const key of candidates) {
    const style = theme.typographyStyles.find((item) => item.styleKey === key);
    if (style) return style;
  }
  return null;
}

export function styleByPdfRole(
  theme: ThemeDefinition | null | undefined,
  role: "heading" | "body" | "mono" | "symbol",
): ThemeTypographyStyle | null {
  return theme?.typographyStyles.find((item) => item.pdfRole === role) ?? null;
}

export function cssFontFamily(style: ThemeTypographyStyle | null | undefined) {
  const family = style?.cssFamily?.trim() || style?.fontFamily?.trim();
  if (!family) return undefined;
  return JSON.stringify(family);
}

export function formatOptionalNumber(
  value: number | null | undefined,
  unit = "",
) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value}${unit}`
    : "-";
}
