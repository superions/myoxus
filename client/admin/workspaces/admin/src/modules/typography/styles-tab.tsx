// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Generic typography_styles editor.
 *
 * The hierarchy/body/inline tabs intentionally expose curated controls for the
 * common operator workflow. This tab is the escape hatch that keeps every
 * server-owned `style_key` visible and editable, so newly seeded semantic
 * styles are not silently hidden by a client-side slot list.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  AuthoringTypographyText,
  Badge,
  Button,
  Divider,
  Group,
  Input,
  NumberInput,
  ResponsiveGrid,
  FormSelect,
  SettingsEmptyState,
  SettingsField,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  Stack,
  StatusDot,
  Textarea,
} from "@myoxus/ui-facade";
import { useMemo, useRef, useState } from "react";

import type { TypographyStylePatchInput } from "../theme/theme-api";
import type {
  ThemeDefinition,
  ThemeFontFamily,
  ThemeTypographyStyle,
} from "../theme/theme-contract";
import {
  findTypographyFontEntry,
  typographyFontEntriesFromCatalog,
  type TypographyFontFamilyEntry,
  typographyFontRefFromCatalog,
} from "./api";
import { FontFamilySelect } from "./font-family-select";
import { FontWeightSelect } from "./font-weight-select";
import { typographyCatalogStylePreviewStyle } from "./preview-styles";

type EditableStyle = ThemeTypographyStyle & {
  fontFeaturesText: string;
  fontVariationsText: string;
};
type Translate = (key: string, values?: Record<string, string>) => string;

const FONT_STYLES = ["normal", "italic"] as const;
const TEXT_TRANSFORMS = [
  "",
  "none",
  "uppercase",
  "lowercase",
  "capitalize",
] as const;
const DECORATIONS = ["", "none", "underline", "line-through"] as const;
const PDF_ROLES = ["", "heading", "body", "mono", "symbol"] as const;
const SIZE_LIMIT = { min: 6, max: 200 };
const LINE_HEIGHT_LIMIT = { min: 0.5, max: 4 };
const LETTER_SPACING_LIMIT = { min: -0.5, max: 1 };

function jsonText(value: unknown) {
  if (
    !value ||
    (typeof value === "object" && Object.keys(value).length === 0)
  ) {
    return "{}";
  }
  return JSON.stringify(value, null, 2);
}

function toEditable(style: ThemeTypographyStyle): EditableStyle {
  return {
    ...style,
    fontStyle: style.fontStyle ?? "normal",
    textTransform: style.textTransform ?? "",
    decoration: style.decoration ?? "",
    hoverDecoration: style.hoverDecoration ?? "",
    pdfRole: style.pdfRole ?? "",
    fontFeaturesText: jsonText(style.fontFeatures),
    fontVariationsText: jsonText(style.fontVariations),
  };
}

function normalizeStyle(style: EditableStyle) {
  return {
    styleKey: style.styleKey,
    fontFamilySlug: style.fontFamilySlug ?? "",
    fontFamily: style.fontFamily,
    cssFamily: style.cssFamily ?? "",
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle ?? "normal",
    sizePx: style.sizePx ?? null,
    lineHeight: style.lineHeight ?? null,
    letterSpacingEm: style.letterSpacingEm ?? null,
    textTransform: style.textTransform || null,
    decoration: style.decoration || null,
    hoverDecoration: style.hoverDecoration || null,
    pdfRole: style.pdfRole || null,
    fontFeaturesText: style.fontFeaturesText.trim() || "{}",
    fontVariationsText: style.fontVariationsText.trim() || "{}",
  };
}

function stylesEqual(a: EditableStyle, b: EditableStyle) {
  return (
    JSON.stringify(normalizeStyle(a)) === JSON.stringify(normalizeStyle(b))
  );
}

function parseObjectJson(
  value: string,
  field: string,
): Record<string, unknown> {
  const trimmed = value.trim() || "{}";
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function validateNumberRange(
  value: number | null | undefined,
  label: string,
  min: number,
  max: number,
  t: Translate,
) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    return t("admin.typography.styles.validation.number-range", {
      field: label,
      min: String(min),
      max: String(max),
    });
  }
  return null;
}

function numericOrUndefined(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function numberOrNull(value: string | number): number | null {
  if (value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function patchForStyle(
  style: EditableStyle,
  entries: readonly TypographyFontFamilyEntry[],
): TypographyStylePatchInput {
  const entry = findTypographyFontEntry(entries, style.fontFamily);
  if (!entry) {
    throw new Error(
      `Typography font family is not selectable: ${style.fontFamily}`,
    );
  }

  return {
    styleKey: style.styleKey,
    fontFamilySlug: entry.slug,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle || "normal",
    sizePx: numericOrUndefined(style.sizePx),
    lineHeight: numericOrUndefined(style.lineHeight),
    letterSpacingEm: numericOrUndefined(style.letterSpacingEm),
    textTransform: style.textTransform || undefined,
    decoration: style.decoration || undefined,
    hoverDecoration: style.hoverDecoration || undefined,
    pdfRole: style.pdfRole || undefined,
    fontFeatures: parseObjectJson(style.fontFeaturesText, "fontFeatures"),
    fontVariations: parseObjectJson(style.fontVariationsText, "fontVariations"),
  };
}

function validateStyle(
  style: EditableStyle,
  entries: readonly TypographyFontFamilyEntry[],
  t: Translate,
) {
  const errors: string[] = [];
  if (!findTypographyFontEntry(entries, style.fontFamily)) {
    errors.push(
      t("admin.typography.styles.validation.font", {
        family: style.fontFamily,
      }),
    );
  }
  for (const error of [
    validateNumberRange(
      style.sizePx,
      t("admin.typography.field.size"),
      SIZE_LIMIT.min,
      SIZE_LIMIT.max,
      t,
    ),
    validateNumberRange(
      style.lineHeight,
      t("admin.typography.field.line-height"),
      LINE_HEIGHT_LIMIT.min,
      LINE_HEIGHT_LIMIT.max,
      t,
    ),
    validateNumberRange(
      style.letterSpacingEm,
      t("admin.typography.field.letter-spacing"),
      LETTER_SPACING_LIMIT.min,
      LETTER_SPACING_LIMIT.max,
      t,
    ),
  ]) {
    if (error) errors.push(error);
  }
  try {
    parseObjectJson(style.fontFeaturesText, "fontFeatures");
  } catch {
    errors.push(
      t("admin.typography.styles.validation.json-object", {
        field: "fontFeatures",
      }),
    );
  }
  try {
    parseObjectJson(style.fontVariationsText, "fontVariations");
  } catch {
    errors.push(
      t("admin.typography.styles.validation.json-object", {
        field: "fontVariations",
      }),
    );
  }
  return errors;
}

function sortedStyleList(styles: readonly ThemeTypographyStyle[]) {
  return [...styles].sort((a, b) => a.styleKey.localeCompare(b.styleKey));
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <SettingsField label={label} labelFor={id}>
      <NumberInput
        id={id}
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        disabled={disabled}
        data-testid={id}
        onChange={(next) => onChange(numberOrNull(next))}
      />
    </SettingsField>
  );
}

function SelectField({
  id,
  label,
  value,
  values,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null | undefined;
  values: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsField label={label} labelFor={id}>
      <FormSelect
        id={id}
        value={value ?? ""}
        disabled={disabled}
        data-testid={id}
        data={values.map((item) => ({
          value: item,
          label: item || "-",
        }))}
        onChange={(next) => onChange(next ?? "")}
      />
    </SettingsField>
  );
}

export function StylesTab({
  activeTheme,
  fontFamilies,
  readOnly = false,
  isSaving = false,
  onSave,
  headingLevel = 2,
}: {
  activeTheme: ThemeDefinition | null;
  fontFamilies: readonly ThemeFontFamily[];
  readOnly?: boolean;
  isSaving?: boolean;
  onSave: (styles: TypographyStylePatchInput[]) => Promise<ThemeDefinition>;
  headingLevel?: 2 | 4;
}) {
  const i18n = useI18n();
  const [baseline, setBaseline] = useState<EditableStyle[]>([]);
  const [draft, setDraft] = useState<EditableStyle[]>([]);
  const [filterText, setFilterText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string[]>
  >({});
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const fontEntries = useMemo(
    () => typographyFontEntriesFromCatalog(fontFamilies),
    [fontFamilies],
  );
  const activeThemeRevision = useMemo(
    () =>
      JSON.stringify({
        slug: activeTheme?.slug ?? null,
        typographySlug: activeTheme?.typographySlug ?? null,
        typographyStyles: sortedStyleList(activeTheme?.typographyStyles ?? []),
      }),
    [activeTheme],
  );

  const [serverRevision, setServerRevision] = useState<string | null>(null);
  if (serverRevision !== activeThemeRevision) {
    setServerRevision(activeThemeRevision);
    const parsed = JSON.parse(activeThemeRevision) as {
      typographyStyles: ThemeTypographyStyle[];
    };
    const next = sortedStyleList(parsed.typographyStyles).map(toEditable);
    setBaseline(next);
    // Refresh clean fields while preserving edited fields across tab Activity
    // reactivation and authoritative readback from another typography tab.
    setDraft(
      next.map((incoming) => {
        const original = baseline.find(
          (item) => item.styleKey === incoming.styleKey,
        );
        const edited = draft.find(
          (item) => item.styleKey === incoming.styleKey,
        );
        if (!original || !edited) return incoming;
        const changes = Object.fromEntries(
          Object.keys(edited)
            .filter(
              (key) =>
                edited[key as keyof EditableStyle] !==
                original[key as keyof EditableStyle],
            )
            .map((key) => [key, edited[key as keyof EditableStyle]]),
        );
        return { ...incoming, ...changes };
      }),
    );
  }

  const dirtyStyles = useMemo(
    () =>
      draft.filter((style) => {
        const original = baseline.find(
          (item) => item.styleKey === style.styleKey,
        );
        return !original || !stylesEqual(original, style);
      }),
    [baseline, draft],
  );
  const visibleStyles = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return draft;
    return draft.filter((style) =>
      [
        style.styleKey,
        style.fontFamily,
        style.fontFamilySlug,
        style.pdfRole,
        style.fontStyle,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [draft, filterText]);
  const dirty = dirtyStyles.length > 0;
  const disabled = readOnly || isSaving || saving || fontEntries.length === 0;

  const updateStyle = (styleKey: string, patch: Partial<EditableStyle>) => {
    setDraft((current) =>
      current.map((style) =>
        style.styleKey === styleKey ? { ...style, ...patch } : style,
      ),
    );
    setSaved(false);
    setError(null);
    setValidationErrors((current) => {
      if (!current[styleKey]) return current;
      const next = { ...current };
      delete next[styleKey];
      return next;
    });
  };

  const save = async () => {
    if (disabled || !dirty || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    try {
      const nextValidationErrors = Object.fromEntries(
        dirtyStyles
          .map((style) => [
            style.styleKey,
            validateStyle(style, fontEntries, (key, values) =>
              i18n.t(key, values),
            ),
          ])
          .filter(([, errors]) => (errors as string[]).length > 0),
      ) as Record<string, string[]>;
      if (Object.keys(nextValidationErrors).length > 0) {
        setValidationErrors(nextValidationErrors);
        setSaved(false);
        setError(i18n.t("admin.typography.styles.validation.failed"));
        return;
      }
      const patches = dirtyStyles.map((style) =>
        patchForStyle(style, fontEntries),
      );
      if (patches.length === 0) return;
      const updatedTheme = await onSave(patches);
      const accepted = sortedStyleList(updatedTheme.typographyStyles ?? []).map(
        toEditable,
      );
      setBaseline(accepted);
      setDraft(accepted);
      setSaved(true);
      setError(null);
      setValidationErrors({});
    } catch (err) {
      setSaved(false);
      setError(
        err instanceof Error
          ? err.message
          : i18n.t("admin.typography.failed-save"),
      );
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(baseline);
    setError(null);
    setValidationErrors({});
    setSaved(false);
    queueMicrotask(() =>
      sectionRef.current
        ?.querySelector<HTMLInputElement>("#typography-styles-filter")
        ?.focus(),
    );
  };

  return (
    <Stack
      component="section"
      ref={sectionRef}
      data-testid="typography-styles-tab"
    >
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={headingLevel}>
          {i18n.t("admin.typography.styles.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.typography.styles.helper")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Group justify="flex-end">
        {dirty ? (
          <StatusDot
            tone="warning"
            label={i18n.t("admin.typography.styles.changed", {
              count: String(dirtyStyles.length),
            })}
          />
        ) : saved ? (
          <StatusDot tone="success" label={i18n.t("admin.state.saved")} />
        ) : null}
        <StatusDot
          tone="info"
          label={`${visibleStyles.length}/${draft.length}`}
        />
        {dirty ? (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            data-testid="typography-styles-discard"
            onClick={discard}
          >
            {i18n.t("admin.actions.cancel")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="primary"
          disabled={!dirty || disabled}
          onClick={() => void save()}
          data-testid="typography-styles-save"
        >
          {i18n.t("admin.actions.save")}
        </Button>
      </Group>
      <SettingsField
        label={i18n.t("admin.typography.styles.search-placeholder")}
        labelFor="typography-styles-filter"
      >
        <Input
          id="typography-styles-filter"
          value={filterText}
          block
          disabled={draft.length === 0}
          data-testid="typography-styles-filter"
          onChange={setFilterText}
        />
      </SettingsField>
      {error ? (
        <SettingsNotice
          tone="error"
          role="alert"
          data-testid="typography-styles-error"
        >
          {error}
        </SettingsNotice>
      ) : null}
      {visibleStyles.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.typography.styles.empty-filter")}
        />
      ) : (
        <Accordion
          variant="contained"
          multiple
          defaultValue={visibleStyles[0] ? [visibleStyles[0].styleKey] : []}
        >
          {visibleStyles.map((style) => (
            <AccordionItem
              key={style.styleKey}
              value={style.styleKey}
              data-testid={`typography-style-editor-${style.styleKey}`}
            >
              <AccordionControl>
                <Group justify="space-between" wrap="nowrap">
                  <Stack gap="var(--mantine-spacing-2xs)">
                    <SettingsListItemTitle>
                      {style.styleKey}
                    </SettingsListItemTitle>
                    <SettingsListItemMeta>
                      {style.fontFamily} · {style.fontWeight}
                      {style.sizePx ? ` · ${style.sizePx}px` : ""}
                    </SettingsListItemMeta>
                  </Stack>
                  {style.pdfRole ? (
                    <Badge tone="info">
                      {i18n.t("admin.typography.styles.pdf-role")}:{" "}
                      {style.pdfRole}
                    </Badge>
                  ) : null}
                </Group>
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  <AuthoringTypographyText
                    component="span"
                    data-admin-visual-role="authoring-preview"
                    style={typographyCatalogStylePreviewStyle(style)}
                  >
                    {i18n.t("admin.typography.preview.pangram")}
                  </AuthoringTypographyText>
                  {validationErrors[style.styleKey]?.length ? (
                    <SettingsNotice
                      tone="error"
                      role="alert"
                      data-testid={`${style.styleKey}-validation-errors`}
                    >
                      {validationErrors[style.styleKey].map((item) => (
                        <div key={item}>{item}</div>
                      ))}
                    </SettingsNotice>
                  ) : null}

                  <ResponsiveGrid cols={{ base: 1, sm: 2, lg: 4 }}>
                    <SettingsField
                      label={i18n.t("admin.typography.field.family")}
                      labelFor={`${style.styleKey}-family`}
                    >
                      <FontFamilySelect
                        id={`${style.styleKey}-family`}
                        value={style.fontFamily}
                        fontFamilies={fontFamilies}
                        disabled={disabled}
                        onChange={(family) =>
                          updateStyle(style.styleKey, {
                            ...typographyFontRefFromCatalog(
                              fontFamilies,
                              family,
                            ),
                          })
                        }
                      />
                    </SettingsField>
                    <SettingsField
                      label={i18n.t("admin.typography.field.weight")}
                      labelFor={`${style.styleKey}-weight`}
                    >
                      <FontWeightSelect
                        id={`${style.styleKey}-weight`}
                        family={style.fontFamily}
                        value={style.fontWeight}
                        fontFamilies={fontFamilies}
                        disabled={disabled}
                        onChange={(fontWeight) =>
                          updateStyle(style.styleKey, { fontWeight })
                        }
                      />
                    </SettingsField>
                    <SelectField
                      id={`${style.styleKey}-style`}
                      label={i18n.t("admin.typography.field.font-style")}
                      value={style.fontStyle}
                      values={FONT_STYLES}
                      disabled={disabled}
                      onChange={(fontStyle) =>
                        updateStyle(style.styleKey, { fontStyle })
                      }
                    />
                    <SelectField
                      id={`${style.styleKey}-pdf-role`}
                      label={i18n.t("admin.typography.styles.pdf-role")}
                      value={style.pdfRole}
                      values={PDF_ROLES}
                      disabled={disabled}
                      onChange={(pdfRole) =>
                        updateStyle(style.styleKey, { pdfRole })
                      }
                    />
                    <NumberField
                      id={`${style.styleKey}-size`}
                      label={i18n.t("admin.typography.field.size")}
                      value={style.sizePx}
                      min={SIZE_LIMIT.min}
                      max={SIZE_LIMIT.max}
                      step={1}
                      disabled={disabled}
                      onChange={(sizePx) =>
                        updateStyle(style.styleKey, { sizePx })
                      }
                    />
                    <NumberField
                      id={`${style.styleKey}-line-height`}
                      label={i18n.t("admin.typography.field.line-height")}
                      value={style.lineHeight}
                      min={LINE_HEIGHT_LIMIT.min}
                      max={LINE_HEIGHT_LIMIT.max}
                      step={0.05}
                      disabled={disabled}
                      onChange={(lineHeight) =>
                        updateStyle(style.styleKey, { lineHeight })
                      }
                    />
                    <NumberField
                      id={`${style.styleKey}-letter-spacing`}
                      label={i18n.t("admin.typography.field.letter-spacing")}
                      value={style.letterSpacingEm}
                      min={LETTER_SPACING_LIMIT.min}
                      max={LETTER_SPACING_LIMIT.max}
                      step={0.005}
                      disabled={disabled}
                      onChange={(letterSpacingEm) =>
                        updateStyle(style.styleKey, { letterSpacingEm })
                      }
                    />
                    <SelectField
                      id={`${style.styleKey}-transform`}
                      label={i18n.t("admin.typography.styles.text-transform")}
                      value={style.textTransform}
                      values={TEXT_TRANSFORMS}
                      disabled={disabled}
                      onChange={(textTransform) =>
                        updateStyle(style.styleKey, { textTransform })
                      }
                    />
                    <SelectField
                      id={`${style.styleKey}-decoration`}
                      label={i18n.t("admin.typography.field.decoration")}
                      value={style.decoration}
                      values={DECORATIONS}
                      disabled={disabled}
                      onChange={(decoration) =>
                        updateStyle(style.styleKey, { decoration })
                      }
                    />
                    <SelectField
                      id={`${style.styleKey}-hover-decoration`}
                      label={i18n.t("admin.typography.field.hover-decoration")}
                      value={style.hoverDecoration}
                      values={DECORATIONS}
                      disabled={disabled}
                      onChange={(hoverDecoration) =>
                        updateStyle(style.styleKey, { hoverDecoration })
                      }
                    />
                  </ResponsiveGrid>

                  <Divider />
                  <SettingsListItemTitle>
                    {i18n.t("admin.typography.styles.advanced-json")}
                  </SettingsListItemTitle>
                  <ResponsiveGrid cols={{ base: 1, lg: 2 }}>
                    <SettingsField
                      label={i18n.t("admin.typography.styles.font-features")}
                      labelFor={`${style.styleKey}-features`}
                    >
                      <Textarea
                        id={`${style.styleKey}-features`}
                        value={style.fontFeaturesText}
                        disabled={disabled}
                        data-testid={`${style.styleKey}-features`}
                        onChange={(value) =>
                          updateStyle(style.styleKey, {
                            fontFeaturesText: value,
                          })
                        }
                      />
                    </SettingsField>
                    <SettingsField
                      label={i18n.t("admin.typography.styles.font-variations")}
                      labelFor={`${style.styleKey}-variations`}
                    >
                      <Textarea
                        id={`${style.styleKey}-variations`}
                        value={style.fontVariationsText}
                        disabled={disabled}
                        data-testid={`${style.styleKey}-variations`}
                        onChange={(value) =>
                          updateStyle(style.styleKey, {
                            fontVariationsText: value,
                          })
                        }
                      />
                    </SettingsField>
                  </ResponsiveGrid>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </Stack>
  );
}
