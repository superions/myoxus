/**
 * Typography — Hierarchy tab.
 *
 * Keeps the hierarchy levels in one compact accordion. The active level exposes
 * its family, weight, geometry controls and a live preview without making all
 * five editors compete for vertical space.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  AuthoringTypographyPreview,
  AuthoringTypographyText,
  Group,
  NumberInput,
  ResponsiveGrid,
  SettingsField,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  Stack,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

import type { ThemeFontFamily } from "../theme/theme-contract";
import {
  HIERARCHY_TOKEN_KEYS,
  type HierarchyToken,
  type HierarchyTokenKey,
  typographyFontRefFromCatalog,
  type TypographyTokens,
} from "./api";
import { FontFamilySelect } from "./font-family-select";
import { FontWeightSelect } from "./font-weight-select";
import { typographyTextPreviewStyle } from "./preview-styles";
import type {
  TypographyNumberChange,
  TypographyNumberDrafts,
} from "./scoped-typography-editor";

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function HierarchyTab({
  tokens,
  fontFamilies,
  onChange,
  readOnly = false,
  actions,
  headingLevel = 2,
  numberDrafts = {},
  onNumberChange = (_id, value, commit) => commit(toNumber(value)),
}: {
  tokens: TypographyTokens;
  fontFamilies: readonly ThemeFontFamily[];
  onChange?: (key: HierarchyTokenKey, next: HierarchyToken) => void;
  readOnly?: boolean;
  actions?: ReactNode;
  headingLevel?: 2 | 4;
  numberDrafts?: TypographyNumberDrafts;
  onNumberChange?: TypographyNumberChange;
}) {
  const i18n = useI18n();
  const commit = (key: HierarchyTokenKey, next: HierarchyToken) => {
    if (!readOnly) onChange?.(key, next);
  };

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={headingLevel}>
          {i18n.t("admin.typography.tab.hierarchy")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.typography.hierarchy.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {actions ? <Group justify="flex-end">{actions}</Group> : null}
      <Accordion variant="contained" multiple defaultValue={["h1"]}>
        {HIERARCHY_TOKEN_KEYS.map((key) => {
          const token = tokens[key];
          const labelKey = `admin.typography.${key}.label` as const;
          return (
            <AccordionItem
              key={key}
              value={key}
              data-testid={`hierarchy-card-${key}`}
            >
              <AccordionControl>
                <Stack gap="var(--mantine-spacing-2xs)">
                  <SettingsListItemTitle>
                    {i18n.t(labelKey)}
                  </SettingsListItemTitle>
                  <SettingsListItemMeta>
                    {token.family} · {token.weight} · {token.size}px
                  </SettingsListItemMeta>
                </Stack>
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  <ResponsiveGrid cols={{ base: 1, md: 2, lg: 3 }}>
                    <SettingsField
                      label={i18n.t("admin.typography.field.family")}
                      labelFor={`${key}-family`}
                    >
                      <FontFamilySelect
                        id={`${key}-family`}
                        value={token.family}
                        fontFamilies={fontFamilies}
                        disabled={readOnly}
                        onChange={(family) =>
                          commit(key, {
                            ...token,
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
                      labelFor={`${key}-weight`}
                    >
                      <FontWeightSelect
                        id={`${key}-weight`}
                        family={token.family}
                        value={token.weight}
                        fontFamilies={fontFamilies}
                        disabled={readOnly}
                        onChange={(weight) => commit(key, { ...token, weight })}
                      />
                    </SettingsField>

                    <SettingsField
                      label={i18n.t("admin.typography.field.size")}
                      labelFor={`${key}-size`}
                    >
                      <NumberInput
                        id={`${key}-size`}
                        min={8}
                        max={120}
                        step={1}
                        value={numberDrafts[`${key}-size`] ?? token.size}
                        error={numberDrafts[`${key}-size`] !== undefined}
                        disabled={readOnly}
                        onChange={(value) =>
                          onNumberChange(`${key}-size`, value, (size) =>
                            commit(key, {
                              ...token,
                              size,
                            }),
                          )
                        }
                        data-testid={`hierarchy-${key}-size`}
                      />
                    </SettingsField>

                    <SettingsField
                      label={i18n.t("admin.typography.field.line-height")}
                      labelFor={`${key}-line-height`}
                    >
                      <NumberInput
                        id={`${key}-line-height`}
                        min={0.8}
                        max={3}
                        step={0.05}
                        value={
                          numberDrafts[`${key}-line-height`] ?? token.lineHeight
                        }
                        error={numberDrafts[`${key}-line-height`] !== undefined}
                        disabled={readOnly}
                        onChange={(value) =>
                          onNumberChange(
                            `${key}-line-height`,
                            value,
                            (lineHeight) =>
                              commit(key, {
                                ...token,
                                lineHeight,
                              }),
                          )
                        }
                      />
                    </SettingsField>

                    <SettingsField
                      label={i18n.t("admin.typography.field.letter-spacing")}
                      labelFor={`${key}-letter-spacing`}
                    >
                      <NumberInput
                        id={`${key}-letter-spacing`}
                        min={-0.1}
                        max={0.5}
                        step={0.005}
                        value={
                          numberDrafts[`${key}-letter-spacing`] ??
                          token.letterSpacing
                        }
                        error={
                          numberDrafts[`${key}-letter-spacing`] !== undefined
                        }
                        disabled={readOnly}
                        onChange={(value) =>
                          onNumberChange(
                            `${key}-letter-spacing`,
                            value,
                            (letterSpacing) =>
                              commit(key, {
                                ...token,
                                letterSpacing,
                              }),
                          )
                        }
                      />
                    </SettingsField>
                  </ResponsiveGrid>

                  <AuthoringTypographyPreview
                    data-testid={`hierarchy-${key}-preview`}
                    style={typographyTextPreviewStyle(token)}
                  >
                    <AuthoringTypographyText>
                      {i18n.t("admin.typography.preview.pangram")}
                    </AuthoringTypographyText>
                  </AuthoringTypographyPreview>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </Accordion>
    </Stack>
  );
}
