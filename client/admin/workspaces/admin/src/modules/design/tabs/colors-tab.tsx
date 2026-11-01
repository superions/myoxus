// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Color-schema editor for the server-owned theme model.
 *
 * The UI only collects typed `(mode, tokenKey, value)` patches. Token
 * existence, locked-system clone-on-write and final normalization stay in the
 * AdminRoot server mutation, so this component cannot become a second color
 * schema authority.
 */
import { useI18n } from "@myoxus/i18n";
import {
  AuthoringColorPreview,
  AuthoringColorPreviewLine,
  AuthoringColorPreviewSample,
  AuthoringPreviewDescription,
  AuthoringPreviewHeader,
  AuthoringPreviewTagline,
  AuthoringPreviewTitle,
  AuthoringTypographyCode,
  AuthoringTypographyLink,
  AuthoringTypographyText,
  Badge,
  Button,
  ColorInput,
  Input,
  MyoxusSegmentedControl,
  ResponsiveGrid,
  SettingsHeadingGroup,
  SettingsField,
  SettingsMasterDetailLayout,
  SettingsSection,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatusDot,
} from "@myoxus/ui-facade";
import { useMemo, useRef, useState } from "react";

import { useSetColorSchemaValuesMutation } from "../../theme/theme-api";
import {
  COLOR_TOKEN_KEYS,
  type ColorMode,
  type ColorTokenKey,
  getThemeColors,
  type ThemeDefinition,
} from "../../theme/theme-contract";
import {
  designColorPreviewStyle,
  designTypographyPreviewStyle,
} from "../preview-styles";

interface TokenSection {
  id: "surfaces" | "ink" | "accents" | "status";
  tokens: readonly ColorTokenKey[];
}

type EditableColors = Record<ColorMode, Record<ColorTokenKey, string>>;

const SECTIONS: readonly TokenSection[] = [
  {
    id: "surfaces",
    tokens: ["paper", "paper-deep", "background-code-block", "rule"],
  },
  { id: "ink", tokens: ["ink", "ink-soft", "ink-mute"] },
  {
    id: "accents",
    tokens: ["accent-primary", "accent-secondary", "link-default"],
  },
  {
    id: "status",
    tokens: [
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
    ],
  },
] as const;

const MODE_LABEL_KEYS = {
  light: "admin.design.mode.light",
  dark: "admin.design.mode.dark",
} as const satisfies Record<ColorMode, string>;

const SECTION_LABEL_KEYS = {
  surfaces: "admin.design.colors.section.surfaces",
  ink: "admin.design.colors.section.ink",
  accents: "admin.design.colors.section.accents",
  status: "admin.design.colors.section.status",
} as const satisfies Record<TokenSection["id"], string>;

const TOKEN_LABEL_KEYS = {
  paper: "admin.design.colors.token.paper",
  "paper-deep": "admin.design.colors.token.paper-deep",
  "background-code-block": "admin.design.colors.token.background-code-block",
  ink: "admin.design.colors.token.ink",
  "ink-soft": "admin.design.colors.token.ink-soft",
  "ink-mute": "admin.design.colors.token.ink-mute",
  rule: "admin.design.colors.token.rule",
  "accent-primary": "admin.design.colors.token.accent-primary",
  "accent-secondary": "admin.design.colors.token.accent-secondary",
  "link-default": "admin.design.colors.token.link-default",
  "status-success-paper": "admin.design.colors.token.status-success-paper",
  "status-success-deep": "admin.design.colors.token.status-success-deep",
  "status-pending-paper": "admin.design.colors.token.status-pending-paper",
  "status-pending-deep": "admin.design.colors.token.status-pending-deep",
  "status-error-paper": "admin.design.colors.token.status-error-paper",
  "status-error-deep": "admin.design.colors.token.status-error-deep",
  "status-preset-paper": "admin.design.colors.token.status-preset-paper",
  "status-preset-deep": "admin.design.colors.token.status-preset-deep",
  "status-info-paper": "admin.design.colors.token.status-info-paper",
  "status-info-deep": "admin.design.colors.token.status-info-deep",
} as const satisfies Record<ColorTokenKey, string>;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function emptyColorMode(): Record<ColorTokenKey, string> {
  return Object.fromEntries(COLOR_TOKEN_KEYS.map((key) => [key, ""])) as Record<
    ColorTokenKey,
    string
  >;
}

function colorsForMode(
  theme: ThemeDefinition | null | undefined,
  mode: ColorMode,
): Record<ColorTokenKey, string> {
  return { ...emptyColorMode(), ...getThemeColors(theme, mode) };
}

function colorsToDraft(
  theme: ThemeDefinition | null | undefined,
): EditableColors {
  return {
    light: colorsForMode(theme, "light"),
    dark: colorsForMode(theme, "dark"),
  };
}

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function isValidHex(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value.trim());
}

function previewColor(value: string | undefined, fallback: string): string {
  return value && isValidHex(value) ? normalizeHex(value) : fallback;
}

function colorRevision(theme: ThemeDefinition | null | undefined): string {
  if (!theme) return "none";
  return JSON.stringify({
    slug: theme.slug,
    colorSchemaSlug: theme.colorSchemaSlug,
    colors: theme.colors,
  });
}

export interface ColorsTabProps {
  theme: ThemeDefinition | null | undefined;
  workspaceId?: string | null;
  onSaveStart?: () => boolean;
  onSaveEnd?: () => void;
}

export function ColorsTab({
  theme,
  workspaceId = null,
  onSaveStart,
  onSaveEnd,
}: ColorsTabProps) {
  const i18n = useI18n();
  const [activeMode, setActiveMode] = useState<ColorMode>("light");
  const [baseline, setBaseline] = useState<EditableColors>(() =>
    colorsToDraft(theme),
  );
  const [draft, setDraft] = useState<EditableColors>(() =>
    colorsToDraft(theme),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const saveLock = useRef(false);
  const { setColorSchemaValues, isMutating: mutationPending } =
    useSetColorSchemaValuesMutation();
  const isMutating = mutationPending || isSaving;
  const revision = colorRevision(theme);
  const [serverRevision, setServerRevision] = useState(revision);

  // Read-only recovery and hidden-tab activation must not discard color drafts.
  if (serverRevision !== revision) {
    setServerRevision(revision);
    const next = colorsToDraft(theme);
    setBaseline(next);
    // Sibling typography saves can clone the profile without changing colors.
    // Adopt clean server values without losing locally edited tokens.
    setDraft(
      Object.fromEntries(
        (["light", "dark"] as const).map((mode) => [
          mode,
          Object.fromEntries(
            COLOR_TOKEN_KEYS.map((key) => [
              key,
              normalizeHex(draft[mode][key]) !==
              normalizeHex(baseline[mode][key])
                ? draft[mode][key]
                : next[mode][key],
            ]),
          ),
        ]),
      ) as EditableColors,
    );
    setSaved(false);
  }

  const dirtyPatches = useMemo(
    () =>
      (["light", "dark"] as const).flatMap((mode) =>
        COLOR_TOKEN_KEYS.filter(
          (tokenKey) =>
            normalizeHex(draft[mode][tokenKey]) !==
            normalizeHex(baseline[mode][tokenKey]),
        ).map((tokenKey) => ({
          mode,
          tokenKey,
          value: normalizeHex(draft[mode][tokenKey]),
        })),
      ),
    [baseline, draft],
  );
  const dirty = dirtyPatches.length > 0;
  const activeColors = draft[activeMode];
  const canEdit = Boolean(theme);

  const updateToken = (tokenKey: ColorTokenKey, value: string) => {
    setDraft((current) => ({
      ...current,
      [activeMode]: {
        ...current[activeMode],
        [tokenKey]: value,
      },
    }));
    setSaved(false);
    setSaveError(null);
    setErrors((current) => {
      const next = { ...current };
      delete next[`${activeMode}:${tokenKey}`];
      return next;
    });
  };

  const resetDraft = () => {
    setDraft(baseline);
    setErrors({});
    setSaveError(null);
    setSaved(false);
  };

  const save = async () => {
    if (!canEdit || !dirty || saveLock.current) return;
    const nextErrors = Object.fromEntries(
      dirtyPatches
        .filter((patch) => !isValidHex(patch.value))
        .map((patch) => [
          `${patch.mode}:${patch.tokenKey}`,
          i18n.t("admin.design.colors.invalid-hex"),
        ]),
    );
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setSaved(false);
      setSaveError(i18n.t("admin.design.colors.validation-failed"));
      return;
    }

    if (onSaveStart && !onSaveStart()) return;
    saveLock.current = true;
    setIsSaving(true);
    try {
      const updatedProfile = await setColorSchemaValues({
        workspaceId,
        colors: dirtyPatches,
      });
      const normalized = colorsToDraft(updatedProfile.theme);
      setBaseline(normalized);
      setDraft(normalized);
      setErrors({});
      setSaveError(null);
      setSaved(true);
    } catch (error) {
      setSaved(false);
      setSaveError(
        error instanceof Error
          ? error.message
          : i18n.t("admin.design.colors.failed-save"),
      );
    } finally {
      saveLock.current = false;
      setIsSaving(false);
      onSaveEnd?.();
    }
  };

  const preview = (
    <AuthoringColorPreview
      data-testid="colors-tab-preview"
      style={{
        ...designColorPreviewStyle(activeColors),
        ...designTypographyPreviewStyle(theme),
      }}
    >
      <AuthoringPreviewHeader>
        <AuthoringPreviewTagline>
          {theme?.name ?? i18n.t("admin.design.colors.no-theme")}
        </AuthoringPreviewTagline>
        <AuthoringPreviewDescription>
          {i18n.t("admin.design.colors.preview-copy")}
        </AuthoringPreviewDescription>
      </AuthoringPreviewHeader>
      <AuthoringColorPreviewSample>
        <AuthoringPreviewHeader>
          <AuthoringPreviewTitle>
            {i18n.t("admin.typography.preview.h2")}
          </AuthoringPreviewTitle>
          <AuthoringTypographyText>
            {i18n.t("admin.typography.preview.body")}{" "}
            <AuthoringTypographyLink
              href="#"
              onClick={(event) => event.preventDefault()}
            >
              {i18n.t("admin.typography.preview.link")}
            </AuthoringTypographyLink>
            .
          </AuthoringTypographyText>
        </AuthoringPreviewHeader>
        <AuthoringTypographyText>
          {i18n.t("admin.typography.preview.body.line-1")}{" "}
          {i18n.t("admin.typography.preview.body.line-2")}
        </AuthoringTypographyText>
        <AuthoringTypographyText>
          {i18n.t("admin.typography.preview.body.line-3")}{" "}
          {i18n.t("admin.typography.preview.body.line-4")}{" "}
          <AuthoringTypographyLink
            href="#"
            onClick={(event) => event.preventDefault()}
          >
            {i18n.t("admin.typography.preview.link")}
          </AuthoringTypographyLink>
        </AuthoringTypographyText>
        <AuthoringColorPreviewLine />
        <AuthoringTypographyCode variant="block">
          {i18n.t("admin.typography.preview.body.code-block")}
        </AuthoringTypographyCode>
      </AuthoringColorPreviewSample>
    </AuthoringColorPreview>
  );

  return (
    <SettingsMasterDetailLayout
      detail={preview}
      detailOpen
      mainTestId="design-colors-tab"
      detailTestId="colors-tab-preview-pane"
    >
      <Stack gap="lg">
        <SettingsToolbar justify="space-between" align="flex-start">
          <SettingsHeadingGroup>
            <SettingsStatusText mono>
              {i18n.t("admin.design.colors.kicker")}
            </SettingsStatusText>
            <SettingsSectionHeading level={2}>
              {i18n.t("admin.design.colors.title")}
            </SettingsSectionHeading>
            <SettingsSectionDescription>
              {i18n.t("admin.design.colors.description")}
            </SettingsSectionDescription>
          </SettingsHeadingGroup>
          <MyoxusSegmentedControl
            value={activeMode}
            onChange={(mode) => setActiveMode(mode as ColorMode)}
            testId="colors-tab-mode-switch"
            data={(["light", "dark"] as const).map((mode) => ({
              value: mode,
              label: (
                <span data-testid={`colors-tab-mode-${mode}`}>
                  {i18n.t(MODE_LABEL_KEYS[mode])}
                </span>
              ),
            }))}
          />
        </SettingsToolbar>

        <SettingsSection>
          <SettingsToolbar justify="space-between" align="flex-start">
            <SettingsHeadingGroup>
              <SettingsSectionHeading level={3}>
                {i18n.t("admin.design.colors.editor-title")}
              </SettingsSectionHeading>
              <SettingsSectionDescription>
                {i18n.t(
                  theme?.locked
                    ? "admin.design.colors.clone-note"
                    : "admin.design.colors.edit-helper",
                )}
              </SettingsSectionDescription>
            </SettingsHeadingGroup>
            <SettingsToolbar>
              {dirty ? (
                <StatusDot
                  tone="warning"
                  label={i18n.t("admin.design.colors.changed", {
                    count: String(dirtyPatches.length),
                  })}
                />
              ) : saved ? (
                <StatusDot tone="success" label={i18n.t("admin.state.saved")} />
              ) : null}
              <Button
                type="button"
                variant="secondary"
                disabled={!dirty || isMutating}
                onClick={resetDraft}
                data-testid="colors-tab-reset"
              >
                {i18n.t("admin.actions.reset")}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!dirty || !canEdit || isMutating}
                onClick={() => void save()}
                data-testid="colors-tab-save"
              >
                {i18n.t("admin.actions.save")}
              </Button>
            </SettingsToolbar>
          </SettingsToolbar>
          {!canEdit ? (
            <SettingsStatusText>
              {i18n.t("admin.design.colors.no-edit-theme")}
            </SettingsStatusText>
          ) : null}
          {saveError ? (
            <SettingsStatusText
              data-testid="colors-tab-error"
              role="alert"
              tone="error"
            >
              {saveError}
            </SettingsStatusText>
          ) : null}
        </SettingsSection>

        {SECTIONS.map((section) => (
          <SettingsSection
            key={section.id}
            data-testid={`colors-tab-section-${section.id}`}
          >
            <SettingsToolbar justify="space-between">
              <SettingsSectionHeading level={3}>
                {i18n.t(SECTION_LABEL_KEYS[section.id])}
              </SettingsSectionHeading>
              <Badge>{section.tokens.length}</Badge>
            </SettingsToolbar>
            <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
              {section.tokens.map((token) => {
                const value = activeColors[token];
                const inputId = `colors-${activeMode}-${token}`;
                const error = errors[`${activeMode}:${token}`];
                return (
                  <SettingsField
                    key={token}
                    label={i18n.t(TOKEN_LABEL_KEYS[token])}
                    data-testid={`colors-tab-row-${token}`}
                  >
                    <Input
                      id={inputId}
                      value={value}
                      disabled={!canEdit || isMutating}
                      aria-invalid={Boolean(error)}
                      onChange={(nextValue) => updateToken(token, nextValue)}
                      mono
                      preFix={
                        <ColorInput
                          aria-label={i18n.t(
                            "admin.design.colors.field.picker",
                            { token },
                          )}
                          value={previewColor(value, "#000000")}
                          disabled={!canEdit || isMutating}
                          onChange={(nextValue) =>
                            updateToken(token, nextValue)
                          }
                          data-testid={`colors-tab-picker-${activeMode}-${token}`}
                        />
                      }
                      data-testid={`colors-tab-input-${activeMode}-${token}`}
                    />
                    {error ? (
                      <SettingsStatusText
                        data-testid={`colors-tab-error-${activeMode}-${token}`}
                        tone="error"
                      >
                        {error}
                      </SettingsStatusText>
                    ) : null}
                  </SettingsField>
                );
              })}
            </ResponsiveGrid>
          </SettingsSection>
        ))}
      </Stack>
    </SettingsMasterDetailLayout>
  );
}
