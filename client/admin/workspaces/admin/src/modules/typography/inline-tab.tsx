/**
 * Typography — Inline tab.
 *
 * Edits the {link, mono} groups. Link tokens carry decoration + hover-state
 * settings; mono tokens are used by code blocks and inline code spans.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  AuthoringTypographyCode,
  AuthoringTypographyLink,
  AuthoringTypographyPreview,
  Group,
  NumberInput,
  ResponsiveGrid,
  FormSelect,
  SettingsField,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  Stack,
} from "@myoxus/ui-facade";
import { type ReactNode, useState } from "react";

import type { ThemeFontFamily } from "../theme/theme-contract";
import {
  type LinkToken,
  type MonoToken,
  typographyFontRefFromCatalog,
  type TypographyTokens,
} from "./api";
import { FontFamilySelect } from "./font-family-select";
import { FontWeightSelect } from "./font-weight-select";
import {
  typographyLinkPreviewStyle,
  typographyMonoPreviewStyle,
} from "./preview-styles";
import type {
  TypographyNumberChange,
  TypographyNumberDrafts,
} from "./scoped-typography-editor";

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function InlineTab({
  tokens,
  fontFamilies,
  onChangeLink,
  onChangeMono,
  readOnly = false,
  actions,
  headingLevel = 2,
  numberDrafts = {},
  onNumberChange = (_id, value, commit) => commit(toNumber(value)),
}: {
  tokens: TypographyTokens;
  fontFamilies: readonly ThemeFontFamily[];
  onChangeLink?: (next: LinkToken) => void;
  onChangeMono?: (next: MonoToken) => void;
  readOnly?: boolean;
  actions?: ReactNode;
  headingLevel?: 2 | 4;
  numberDrafts?: TypographyNumberDrafts;
  onNumberChange?: TypographyNumberChange;
}) {
  const i18n = useI18n();
  const link = tokens.link;
  const mono = tokens.mono;
  const [linkPreviewHovered, setLinkPreviewHovered] = useState(false);
  const commitLink = (next: LinkToken) => {
    if (!readOnly) onChangeLink?.(next);
  };
  const commitMono = (next: MonoToken) => {
    if (!readOnly) onChangeMono?.(next);
  };

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={headingLevel}>
          {i18n.t("admin.typography.tab.inline")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.typography.inline.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {actions ? <Group justify="flex-end">{actions}</Group> : null}
      <Accordion variant="contained" multiple defaultValue={["link"]}>
        <AccordionItem value="link" data-testid="inline-card-link">
          <AccordionControl>
            <Stack gap="var(--mantine-spacing-2xs)">
              <SettingsListItemTitle>
                {i18n.t("admin.typography.link.label")}
              </SettingsListItemTitle>
              <SettingsListItemMeta>
                {link.family} · {link.weight} · {link.decoration}
              </SettingsListItemMeta>
            </Stack>
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              <ResponsiveGrid cols={{ base: 1, md: 2, lg: 3 }}>
                <SettingsField
                  label={i18n.t("admin.typography.field.family")}
                  labelFor="link-family"
                >
                  <FontFamilySelect
                    id="link-family"
                    value={link.family}
                    fontFamilies={fontFamilies}
                    disabled={readOnly}
                    onChange={(family) =>
                      commitLink({
                        ...link,
                        ...typographyFontRefFromCatalog(fontFamilies, family),
                      })
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.weight")}
                  labelFor="link-weight"
                >
                  <FontWeightSelect
                    id="link-weight"
                    family={link.family}
                    value={link.weight}
                    fontFamilies={fontFamilies}
                    disabled={readOnly}
                    onChange={(weight) => commitLink({ ...link, weight })}
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.decoration")}
                  labelFor="link-decoration"
                >
                  <FormSelect
                    id="link-decoration"
                    value={link.decoration}
                    disabled={readOnly}
                    data={[
                      {
                        value: "none",
                        label: i18n.t("admin.typography.field.decoration.none"),
                      },
                      {
                        value: "underline",
                        label: i18n.t(
                          "admin.typography.field.decoration.underline",
                        ),
                      },
                    ]}
                    onChange={(value) =>
                      commitLink({
                        ...link,
                        decoration: value as "none" | "underline",
                      })
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.hover-decoration")}
                  labelFor="link-hover-decoration"
                >
                  <FormSelect
                    id="link-hover-decoration"
                    value={link.hoverDecoration}
                    disabled={readOnly}
                    data={[
                      {
                        value: "none",
                        label: i18n.t("admin.typography.field.decoration.none"),
                      },
                      {
                        value: "underline",
                        label: i18n.t(
                          "admin.typography.field.decoration.underline",
                        ),
                      },
                    ]}
                    onChange={(value) =>
                      commitLink({
                        ...link,
                        hoverDecoration: value as "none" | "underline",
                      })
                    }
                  />
                </SettingsField>
              </ResponsiveGrid>
              <AuthoringTypographyPreview
                data-testid="inline-link-preview"
                style={typographyLinkPreviewStyle(
                  link,
                  linkPreviewHovered ? link.hoverDecoration : link.decoration,
                )}
              >
                <AuthoringTypographyLink
                  href="#"
                  onClick={(e) => e.preventDefault()}
                  onMouseEnter={() => setLinkPreviewHovered(true)}
                  onMouseLeave={() => setLinkPreviewHovered(false)}
                >
                  {i18n.t("admin.typography.preview.link")}
                </AuthoringTypographyLink>
              </AuthoringTypographyPreview>
            </Stack>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="mono" data-testid="inline-card-mono">
          <AccordionControl>
            <Stack gap="var(--mantine-spacing-2xs)">
              <SettingsListItemTitle>
                {i18n.t("admin.typography.mono.label")}
              </SettingsListItemTitle>
              <SettingsListItemMeta>
                {mono.family} · {mono.weight} · {mono.size}px
              </SettingsListItemMeta>
            </Stack>
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              <ResponsiveGrid cols={{ base: 1, md: 2, lg: 3 }}>
                <SettingsField
                  label={i18n.t("admin.typography.field.family")}
                  labelFor="mono-family"
                >
                  <FontFamilySelect
                    id="mono-family"
                    value={mono.family}
                    fontFamilies={fontFamilies}
                    disabled={readOnly}
                    onChange={(family) =>
                      commitMono({
                        ...mono,
                        ...typographyFontRefFromCatalog(
                          fontFamilies,
                          family,
                          "monospace",
                        ),
                      })
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.weight")}
                  labelFor="mono-weight"
                >
                  <FontWeightSelect
                    id="mono-weight"
                    family={mono.family}
                    value={mono.weight}
                    fontFamilies={fontFamilies}
                    disabled={readOnly}
                    onChange={(weight) => commitMono({ ...mono, weight })}
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.size")}
                  labelFor="mono-size"
                >
                  <NumberInput
                    id="mono-size"
                    min={8}
                    max={32}
                    step={1}
                    value={numberDrafts["mono-size"] ?? mono.size}
                    error={numberDrafts["mono-size"] !== undefined}
                    disabled={readOnly}
                    onChange={(value) =>
                      onNumberChange("mono-size", value, (size) =>
                        commitMono({ ...mono, size }),
                      )
                    }
                  />
                </SettingsField>
              </ResponsiveGrid>
              <AuthoringTypographyPreview
                data-testid="inline-mono-preview"
                style={typographyMonoPreviewStyle(mono)}
              >
                <AuthoringTypographyCode>
                  {i18n.t("admin.typography.preview.code")}
                </AuthoringTypographyCode>
              </AuthoringTypographyPreview>
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Stack>
  );
}
