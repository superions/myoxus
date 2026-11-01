/**
 * Typography — Fließtext (body) tab.
 *
 * Edits {body, bodySmall, blockquote} groups. body and bodySmall share the
 * same field set as the hierarchy levels; blockquote additionally exposes
 * `fontStyle` (normal/italic).
 */
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  AuthoringTypographyCode,
  AuthoringTypographyPreview,
  AuthoringTypographyQuote,
  AuthoringTypographyText,
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
import type { ReactNode } from "react";

import type {
  ThemeFontFamily,
  ThemeTypographyStyle,
} from "../theme/theme-contract";
import {
  type BlockquoteToken,
  type BodyToken,
  typographyFontRefFromCatalog,
  type TypographyTokens,
} from "./api";
import { FontFamilySelect } from "./font-family-select";
import { FontWeightSelect } from "./font-weight-select";
import {
  typographyMonoPreviewStyle,
  type TypographyPreviewStyle,
  typographyQuotePreviewStyle,
  typographyTextPreviewStyle,
  typographyThemeStylePreviewStyle,
} from "./preview-styles";
import type {
  TypographyNumberChange,
  TypographyNumberDrafts,
} from "./scoped-typography-editor";

const bodyPreviewLineKeys = {
  body: [
    "admin.typography.preview.body.line-1",
    "admin.typography.preview.body.line-2",
    "admin.typography.preview.body.line-3",
    "admin.typography.preview.body.line-4",
  ],
  bodySmall: [
    "admin.typography.preview.body-small.line-1",
    "admin.typography.preview.body-small.line-2",
    "admin.typography.preview.body-small.line-3",
    "admin.typography.preview.body-small.line-4",
  ],
} as const;

const blockquotePreviewLineKeys = [
  "admin.typography.preview.blockquote.line-1",
  "admin.typography.preview.blockquote.line-2",
  "admin.typography.preview.blockquote.line-3",
  "admin.typography.preview.blockquote.line-4",
] as const;

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function bodyPreviewStyle(
  key: "body" | "bodySmall",
  tokens: TypographyTokens,
  token: BodyToken,
  codeBlockStyle: ThemeTypographyStyle | null,
): TypographyPreviewStyle {
  const baseStyle = typographyTextPreviewStyle(token);
  if (key === "bodySmall") {
    return baseStyle;
  }
  return {
    ...baseStyle,
    ...(codeBlockStyle
      ? typographyThemeStylePreviewStyle(codeBlockStyle, "code-block")
      : typographyMonoPreviewStyle(tokens.mono, "code-block")),
  };
}

export function BodyTab({
  tokens,
  codeBlockStyle,
  fontFamilies,
  onChangeBody,
  onChangeBlockquote,
  readOnly = false,
  actions,
  headingLevel = 2,
  numberDrafts = {},
  onNumberChange = (_id, value, commit) => commit(toNumber(value)),
}: {
  tokens: TypographyTokens;
  codeBlockStyle: ThemeTypographyStyle | null;
  fontFamilies: readonly ThemeFontFamily[];
  onChangeBody?: (key: "body" | "bodySmall", next: BodyToken) => void;
  onChangeBlockquote?: (next: BlockquoteToken) => void;
  readOnly?: boolean;
  actions?: ReactNode;
  headingLevel?: 2 | 4;
  numberDrafts?: TypographyNumberDrafts;
  onNumberChange?: TypographyNumberChange;
}) {
  const i18n = useI18n();
  const commitBody = (key: "body" | "bodySmall", next: BodyToken) => {
    if (!readOnly) onChangeBody?.(key, next);
  };
  const commitBlockquote = (next: BlockquoteToken) => {
    if (!readOnly) onChangeBlockquote?.(next);
  };

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={headingLevel}>
          {i18n.t("admin.typography.tab.body")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.typography.body.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {actions ? <Group justify="flex-end">{actions}</Group> : null}
      <Accordion variant="contained" multiple defaultValue={["body"]}>
        {(["body", "bodySmall"] as const).map((key) => {
          const token = tokens[key];
          return (
            <AccordionItem
              key={key}
              value={key}
              data-testid={`body-card-${key}`}
            >
              <AccordionControl>
                <Stack gap="var(--mantine-spacing-2xs)">
                  <SettingsListItemTitle>
                    {i18n.t(`admin.typography.${key}.label` as const)}
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
                      label={
                        key === "body"
                          ? i18n.t(
                              "admin.typography.editor-fonts.field.body-font",
                            )
                          : i18n.t("admin.typography.field.family")
                      }
                      labelFor={`${key}-family`}
                    >
                      <FontFamilySelect
                        id={`${key}-family`}
                        value={token.family}
                        fontFamilies={fontFamilies}
                        disabled={readOnly}
                        onChange={(family) =>
                          commitBody(key, {
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
                        onChange={(weight) =>
                          commitBody(key, { ...token, weight })
                        }
                      />
                    </SettingsField>
                    <SettingsField
                      label={i18n.t("admin.typography.field.size")}
                      labelFor={`${key}-size`}
                    >
                      <NumberInput
                        id={`${key}-size`}
                        min={8}
                        max={48}
                        step={1}
                        value={numberDrafts[`${key}-size`] ?? token.size}
                        error={numberDrafts[`${key}-size`] !== undefined}
                        disabled={readOnly}
                        onChange={(value) =>
                          onNumberChange(`${key}-size`, value, (size) =>
                            commitBody(key, {
                              ...token,
                              size,
                            }),
                          )
                        }
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
                              commitBody(key, {
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
                              commitBody(key, {
                                ...token,
                                letterSpacing,
                              }),
                          )
                        }
                      />
                    </SettingsField>
                  </ResponsiveGrid>

                  <AuthoringTypographyPreview
                    data-testid={`body-${key}-preview`}
                    style={bodyPreviewStyle(key, tokens, token, codeBlockStyle)}
                  >
                    {bodyPreviewLineKeys[key].map((lineKey) => (
                      <AuthoringTypographyText
                        key={lineKey}
                        data-testid={`body-${key}-preview-line`}
                        variant={key === "bodySmall" ? "bodySmall" : "body"}
                      >
                        {i18n.t(lineKey)}
                      </AuthoringTypographyText>
                    ))}
                    {key === "body" ? (
                      <AuthoringTypographyCode
                        data-testid="body-code-block-preview"
                        variant="block"
                      >
                        {i18n.t("admin.typography.preview.body.code-block")}
                      </AuthoringTypographyCode>
                    ) : null}
                  </AuthoringTypographyPreview>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          );
        })}

        <AccordionItem value="blockquote" data-testid="body-card-blockquote">
          <AccordionControl>
            <Stack gap="var(--mantine-spacing-2xs)">
              <SettingsListItemTitle>
                {i18n.t("admin.typography.blockquote.label")}
              </SettingsListItemTitle>
              <SettingsListItemMeta>
                {tokens.blockquote.family} · {tokens.blockquote.weight} ·{" "}
                {tokens.blockquote.size}px
              </SettingsListItemMeta>
            </Stack>
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              <ResponsiveGrid cols={{ base: 1, md: 2, lg: 3 }}>
                <SettingsField
                  label={i18n.t("admin.typography.field.family")}
                  labelFor="blockquote-family"
                >
                  <FontFamilySelect
                    id="blockquote-family"
                    value={tokens.blockquote.family}
                    fontFamilies={fontFamilies}
                    disabled={readOnly}
                    onChange={(family) =>
                      commitBlockquote({
                        ...tokens.blockquote,
                        ...typographyFontRefFromCatalog(
                          fontFamilies,
                          family,
                          "serif",
                        ),
                      })
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.weight")}
                  labelFor="blockquote-weight"
                >
                  <FontWeightSelect
                    id="blockquote-weight"
                    family={tokens.blockquote.family}
                    value={tokens.blockquote.weight}
                    fontFamilies={fontFamilies}
                    disabled={readOnly}
                    onChange={(weight) =>
                      commitBlockquote({ ...tokens.blockquote, weight })
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.size")}
                  labelFor="blockquote-size"
                >
                  <NumberInput
                    id="blockquote-size"
                    min={10}
                    max={48}
                    step={1}
                    value={
                      numberDrafts["blockquote-size"] ?? tokens.blockquote.size
                    }
                    error={numberDrafts["blockquote-size"] !== undefined}
                    disabled={readOnly}
                    onChange={(value) =>
                      onNumberChange("blockquote-size", value, (size) =>
                        commitBlockquote({
                          ...tokens.blockquote,
                          size,
                        }),
                      )
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.line-height")}
                  labelFor="blockquote-line-height"
                >
                  <NumberInput
                    id="blockquote-line-height"
                    min={0.8}
                    max={3}
                    step={0.05}
                    value={
                      numberDrafts["blockquote-line-height"] ??
                      tokens.blockquote.lineHeight
                    }
                    error={numberDrafts["blockquote-line-height"] !== undefined}
                    disabled={readOnly}
                    onChange={(value) =>
                      onNumberChange(
                        "blockquote-line-height",
                        value,
                        (lineHeight) =>
                          commitBlockquote({
                            ...tokens.blockquote,
                            lineHeight,
                          }),
                      )
                    }
                  />
                </SettingsField>
                <SettingsField
                  label={i18n.t("admin.typography.field.font-style")}
                  labelFor="blockquote-style"
                >
                  <FormSelect
                    id="blockquote-style"
                    value={tokens.blockquote.fontStyle}
                    disabled={readOnly}
                    data={[
                      {
                        value: "normal",
                        label: i18n.t(
                          "admin.typography.field.font-style.normal",
                        ),
                      },
                      {
                        value: "italic",
                        label: i18n.t(
                          "admin.typography.field.font-style.italic",
                        ),
                      },
                    ]}
                    onChange={(value) =>
                      commitBlockquote({
                        ...tokens.blockquote,
                        fontStyle: value as "normal" | "italic",
                      })
                    }
                  />
                </SettingsField>
              </ResponsiveGrid>

              <AuthoringTypographyPreview
                data-testid="body-blockquote-preview"
                style={typographyQuotePreviewStyle(tokens.blockquote)}
              >
                <AuthoringTypographyQuote>
                  {blockquotePreviewLineKeys.map((lineKey, index) => (
                    <span
                      key={lineKey}
                      data-testid="body-blockquote-preview-line"
                    >
                      {i18n.t(lineKey)}
                      {index < blockquotePreviewLineKeys.length - 1 ? (
                        <br />
                      ) : null}
                    </span>
                  ))}
                </AuthoringTypographyQuote>
              </AuthoringTypographyPreview>
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Stack>
  );
}
