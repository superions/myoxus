// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * ThemeGallery renders the server-owned theme catalog. It deliberately does
 * not import client preset files: the database catalog is the authoring source,
 * and this component only visualizes and selects records exposed via AdminRoot.
 */
import { useI18n } from "@myoxus/i18n";
import {
  AuthoringColorPreviewLine,
  AuthoringColorPreviewSample,
  AuthoringPreviewCard,
  AuthoringPreviewCheck,
  AuthoringPreviewDescription,
  AuthoringPreviewHeader,
  AuthoringPreviewTagline,
  AuthoringPreviewTitle,
  AuthoringTypographyCode,
  AuthoringTypographyText,
  AuthoringTypographyLink,
  Badge,
  MyoxusSegmentedControl,
  ResponsiveGrid,
  SettingsHeadingGroup,
  SettingsSection,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
} from "@myoxus/ui-facade";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { type CSSProperties, useMemo, useState } from "react";

import {
  cssFontFamily,
  getThemeColors,
  resolveColorMode,
  styleByKey,
  type ThemeDefinition,
  type ThemeMode,
  type ThemeTypographyStyle,
} from "../theme/theme-contract";

import { designTypographyPreviewStyle } from "./preview-styles";

type SectionId =
  | "sans-foundations"
  | "refined-editorial"
  | "warm-expressive"
  | "custom"
  | "system";
type FilterId = "all" | "sans" | "expressive" | "dark" | "custom";

const ALL_FILTERS: readonly FilterId[] = [
  "all",
  "sans",
  "expressive",
  "dark",
  "custom",
];
const ALL_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
const SECTION_ORDER: readonly SectionId[] = [
  "sans-foundations",
  "refined-editorial",
  "warm-expressive",
  "custom",
  "system",
];
const MIN_PREVIEW_TEXT_CONTRAST = 4.5;

function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    return `#${short[1]
      .split("")
      .map((part) => `${part}${part}`)
      .join("")}`;
  }
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : null;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (channel) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    },
  );
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(left: string, right: string): number {
  const leftLum = luminance(left);
  const rightLum = luminance(right);
  const lighter = Math.max(leftLum, rightLum);
  const darker = Math.min(leftLum, rightLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function readablePreviewTextColor(
  preferred: string | null | undefined,
  background: string | null | undefined,
  fallback: string,
): string {
  const preferredHex = normalizeHexColor(preferred);
  const backgroundHex = normalizeHexColor(background);
  const fallbackHex = normalizeHexColor(fallback);
  if (!preferred) return fallback;
  if (!preferredHex || !backgroundHex || !fallbackHex) return preferred;
  if (contrastRatio(preferredHex, backgroundHex) >= MIN_PREVIEW_TEXT_CONTRAST) {
    return preferred;
  }
  return contrastRatio(fallbackHex, backgroundHex) >
    contrastRatio(preferredHex, backgroundHex)
    ? fallback
    : preferred;
}

function passesFilter(theme: ThemeDefinition, filter: FilterId): boolean {
  if (filter === "all") return true;
  if (filter === "custom") return theme.origin !== "system";
  if (filter === "sans") {
    return (
      theme.category === "sans-leaning" ||
      theme.previewGroup === "sans-foundations"
    );
  }
  if (filter === "expressive") {
    return Boolean(
      theme.category?.startsWith("expressive") ||
      theme.previewGroup === "refined-editorial" ||
      theme.previewGroup === "warm-expressive",
    );
  }
  const dark = getThemeColors(theme, "dark");
  return Boolean(dark && luminance(dark.paper) < 0.28);
}

function sortThemes(themes: ThemeDefinition[]): ThemeDefinition[] {
  return [...themes].sort((left, right) => {
    const leftOrder = left.previewOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.previewOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

function groupThemes(themes: ThemeDefinition[]) {
  const groups = new Map<SectionId, ThemeDefinition[]>();
  for (const theme of themes) {
    const group = sectionForTheme(theme);
    groups.set(group, [...(groups.get(group) ?? []), theme]);
  }
  return SECTION_ORDER.map((id) => ({
    id,
    themes: sortThemes(groups.get(id) ?? []),
  })).filter((section) => section.themes.length > 0);
}

function sectionForTheme(theme: ThemeDefinition): SectionId {
  if (theme.origin !== "system") return "custom";
  if (isSectionId(theme.previewGroup)) return theme.previewGroup;
  return "system";
}

function isSectionId(value: string | null | undefined): value is SectionId {
  return SECTION_ORDER.includes(value as SectionId);
}

function translateIfPresent(
  i18n: ReturnType<typeof useI18n>,
  key: string | null | undefined,
): string | null {
  if (!key) return null;
  const translated = i18n.t(key as never);
  return translated === key ? null : translated;
}

function preferredStyle(
  theme: ThemeDefinition,
  candidates: readonly string[],
): ThemeTypographyStyle | null {
  return styleByKey(theme, candidates);
}

function letterSpacingValue(style: ThemeTypographyStyle | null): string {
  return typeof style?.letterSpacingEm === "number"
    ? `${style.letterSpacingEm}em`
    : "normal";
}

function cssVariableStyle(
  theme: ThemeDefinition,
  mode: ThemeMode,
): CSSProperties {
  const resolvedMode = resolveColorMode(mode);
  const colors =
    getThemeColors(theme, resolvedMode) ?? getThemeColors(theme, "light");
  const bodyStyle = preferredStyle(theme, ["body.default", "body.small"]);
  const codeBlockStyle = preferredStyle(theme, ["code.block", "code.inline"]);
  const previewSurface = "var(--myoxus-background-primary-color)";
  const previewSurfaceMuted = "var(--myoxus-background-tertiary-color)";
  const previewText = "var(--myoxus-text-primary-color)";
  const cardInk = colors?.ink ?? previewText;
  const cardInkSoft = readablePreviewTextColor(
    colors?.["ink-soft"],
    colors?.paper,
    cardInk,
  );
  const cardInkMute = readablePreviewTextColor(
    colors?.["ink-mute"],
    colors?.paper,
    cardInkSoft,
  );

  // Card-local variables are mandatory: the active root theme must never
  // restyle other previews, otherwise the gallery stops being a trustworthy
  // chooser for typography and color changes.
  return {
    ...designTypographyPreviewStyle(theme),
    "--theme-card-link": colors?.["link-default"],
    "--theme-card-paper": colors?.paper ?? previewSurface,
    "--theme-card-paper-deep": colors?.["paper-deep"] ?? previewSurfaceMuted,
    "--theme-card-background-code-block":
      colors?.["background-code-block"] ?? previewSurfaceMuted,
    "--theme-card-ink": cardInk,
    "--theme-card-ink-soft": cardInkSoft,
    "--theme-card-ink-mute": cardInkMute,
    "--theme-card-rule": colors?.rule ?? "var(--myoxus-border-color)",
    "--theme-card-accent":
      colors?.["accent-primary"] ??
      "var(--myoxus-accent-primary, var(--myoxus-text-emphasis-color))",
    "--theme-card-body-family": cssFontFamily(bodyStyle) ?? "inherit",
    "--theme-card-body-weight": bodyStyle?.fontWeight ?? 400,
    "--authoring-typography-code-block-family":
      cssFontFamily(codeBlockStyle) ?? "monospace",
    "--authoring-typography-code-block-size": `${codeBlockStyle?.sizePx ?? 13}px`,
    "--authoring-typography-code-block-style":
      codeBlockStyle?.fontStyle ?? "normal",
    "--authoring-typography-code-block-weight":
      codeBlockStyle?.fontWeight ?? 400,
    "--authoring-typography-code-block-letter-spacing":
      letterSpacingValue(codeBlockStyle),
    "--authoring-typography-code-block-line-height":
      codeBlockStyle?.lineHeight ?? 1.5,
    "--authoring-typography-code-block-decoration":
      codeBlockStyle?.decoration ?? "none",
    "--authoring-typography-code-block-transform":
      codeBlockStyle?.textTransform ?? "none",
  } as CSSProperties;
}

export interface ThemeGalleryProps {
  themes: ThemeDefinition[];
  activePreset?: string | null;
  activeMode?: string | null;
  onSelectPreset: (slug: string) => void;
  onSelectMode: (mode: ThemeMode) => void;
  isSaving?: boolean;
}

export function ThemeGallery({
  themes,
  activePreset,
  activeMode,
  onSelectPreset,
  onSelectMode,
  isSaving = false,
}: ThemeGalleryProps) {
  const i18n = useI18n();
  const { resolvedTheme } = useMyoxusTheme();
  const [filter, setFilter] = useState<FilterId>("all");
  const mode =
    activeMode === "light" || activeMode === "dark"
      ? activeMode
      : resolvedTheme;

  const visibleSections = useMemo(() => {
    return groupThemes(themes)
      .map((section) => ({
        ...section,
        themes: section.themes.filter((theme) => passesFilter(theme, filter)),
      }))
      .filter((section) => section.themes.length > 0);
  }, [filter, themes]);

  return (
    <Stack gap="lg" data-testid="theme-gallery">
      <SettingsSection>
        <SettingsToolbar justify="space-between" align="flex-start">
          <SettingsHeadingGroup>
            <SettingsStatusText>
              {i18n.t("admin.design.gallery.kicker")}
            </SettingsStatusText>
            <SettingsSectionHeading level={2}>
              {i18n.t("admin.design.gallery.title")}
            </SettingsSectionHeading>
            <SettingsSectionDescription>
              {i18n.t("admin.design.gallery.description")}
            </SettingsSectionDescription>
          </SettingsHeadingGroup>
          <MyoxusSegmentedControl
            aria-label={i18n.t("admin.design.gallery.mode-label")}
            testId="theme-gallery-mode-group"
            value={activeMode ?? "system"}
            disabled={isSaving}
            onChange={(value) => onSelectMode(value as ThemeMode)}
            data={ALL_MODES.map((candidate) => ({
              value: candidate,
              label: i18n.t(`admin.design.mode.${candidate}` as never),
              testId: `theme-gallery-mode-${candidate}`,
            }))}
          />
        </SettingsToolbar>
      </SettingsSection>

      <MyoxusSegmentedControl
        aria-label={i18n.t("admin.design.gallery.filter.label" as never)}
        value={filter}
        layout="fluid"
        onChange={(value) => setFilter(value as FilterId)}
        data={ALL_FILTERS.map((candidate) => ({
          value: candidate,
          label: i18n.t(`admin.design.gallery.filter.${candidate}` as never),
          testId: `theme-gallery-filter-${candidate}`,
        }))}
      />

      {visibleSections.map((section) => (
        <Stack
          component="section"
          gap="sm"
          key={section.id}
          data-testid={`theme-gallery-section-${section.id}`}
        >
          <SettingsToolbar justify="space-between">
            <SettingsSectionHeading level={3}>
              {i18n.t(`admin.design.gallery.section.${section.id}` as never)}
            </SettingsSectionHeading>
            <Badge tone="neutral">{section.themes.length}</Badge>
          </SettingsToolbar>
          <ResponsiveGrid data-testid={`theme-gallery-grid-${section.id}`}>
            {section.themes.map((theme) => (
              <ThemeCard
                key={theme.slug}
                theme={theme}
                mode={mode}
                active={activePreset === theme.slug}
                disabled={isSaving}
                onSelect={() => onSelectPreset(theme.slug)}
              />
            ))}
          </ResponsiveGrid>
        </Stack>
      ))}
    </Stack>
  );
}

function ThemeCard({
  theme,
  mode,
  active,
  disabled,
  onSelect,
}: {
  theme: ThemeDefinition;
  mode: ThemeMode;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const i18n = useI18n();
  const title =
    translateIfPresent(i18n, `admin.design.theme.${theme.slug}.title`) ??
    theme.name;
  const tagline =
    translateIfPresent(i18n, theme.taglineKey) ??
    translateIfPresent(i18n, `admin.design.theme.${theme.slug}.tagline`) ??
    theme.category ??
    theme.origin;
  const description =
    translateIfPresent(i18n, theme.descriptionKey) ??
    translateIfPresent(i18n, `admin.design.theme.${theme.slug}.description`);
  const previewStyle = cssVariableStyle(theme, mode);

  return (
    <AuthoringPreviewCard
      data-myoxus-ui-role="button:preview-card"
      data-authoring-preview-kind="theme-card"
      data-testid={`theme-gallery-card-${theme.slug}`}
      onClick={onSelect}
      disabled={disabled}
      active={active}
      style={previewStyle}
    >
      {active ? <AuthoringPreviewCheck /> : null}

      <AuthoringPreviewHeader>
        <AuthoringPreviewTitle
          data-testid={`theme-gallery-card-title-${theme.slug}`}
        >
          {title}
        </AuthoringPreviewTitle>
        <AuthoringPreviewTagline
          data-testid={`theme-gallery-card-tagline-${theme.slug}`}
        >
          {tagline}
        </AuthoringPreviewTagline>
      </AuthoringPreviewHeader>

      <AuthoringColorPreviewSample
        data-testid={`theme-gallery-card-preview-${theme.slug}`}
      >
        <AuthoringColorPreviewLine tone="accent" width="short" />
        <AuthoringTypographyText>
          {i18n.t("admin.typography.preview.body")}{" "}
          <AuthoringTypographyLink component="span">
            {i18n.t("admin.typography.preview.link")}
          </AuthoringTypographyLink>
          .
        </AuthoringTypographyText>
        <AuthoringTypographyCode variant="block">
          {i18n.t("admin.typography.preview.code")}
        </AuthoringTypographyCode>
      </AuthoringColorPreviewSample>

      {description ? (
        <AuthoringPreviewDescription
          data-testid={`theme-gallery-card-description-${theme.slug}`}
        >
          {description}
        </AuthoringPreviewDescription>
      ) : null}
    </AuthoringPreviewCard>
  );
}
