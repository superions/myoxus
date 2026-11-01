// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Theme font inspector for the global theme model. It replaces the old
 * `branding.editor.*` appConfig editor with a projection of the server-owned
 * typography/font catalog. Editing is handled by typed theme/typography
 * mutations, not by PDF- or admin-local font pickers.
 */
import { useI18n } from "@myoxus/i18n";
import { CodeIcon, FileTextIcon } from "@myoxus/icons/react";
import {
  AuthoringTypographyCode,
  AuthoringTypographyHeading,
  AuthoringTypographyPreview,
  AuthoringTypographyText,
  Badge,
  Group,
  ResponsiveGrid,
  SettingsListItemMeta,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsSection,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";

import {
  formatOptionalNumber,
  styleByKey,
  styleByPdfRole,
  type ThemeDefinition,
  type ThemeFontFamily,
  type ThemeTypographyStyle,
} from "../theme/theme-contract";
import { typographyThemeStylePreviewStyle } from "./preview-styles";

const PREVIEW_CODE = `function exportPdf(theme) {\n  return theme.fonts.body;\n}`;

interface RoleCard {
  id: "heading" | "body" | "mono" | "symbol";
  icon: typeof FileTextIcon;
  style: ThemeTypographyStyle | null;
}

export interface EditorFontsTabProps {
  theme: ThemeDefinition | null | undefined;
  fontFamilies: ThemeFontFamily[];
}

function assetStatus(family: ThemeFontFamily | undefined) {
  const hasWeb = family?.assets.some((asset) => asset.usage === "web") ?? false;
  const hasPdf = family?.assets.some((asset) => asset.usage === "pdf") ?? false;
  if (hasWeb && hasPdf && family?.isSelectable) return "ready";
  if (hasWeb && hasPdf) return "blocked";
  return "incomplete";
}

function statusTone(status: ReturnType<typeof assetStatus>) {
  if (status === "ready") return "success";
  if (status === "blocked") return "warning";
  return "error";
}

export function EditorFontsTab({ theme, fontFamilies }: EditorFontsTabProps) {
  const i18n = useI18n();
  const heading =
    styleByPdfRole(theme, "heading") ??
    styleByKey(theme, ["page.title", "section.title"]);
  const body =
    styleByPdfRole(theme, "body") ?? styleByKey(theme, ["body.default"]);
  const mono =
    styleByPdfRole(theme, "mono") ??
    styleByKey(theme, ["code.inline", "code.block"]);
  const codeBlock = styleByKey(theme, ["code.block"]) ?? mono;
  const symbol =
    styleByPdfRole(theme, "symbol") ?? styleByKey(theme, ["pdf.symbol"]);

  const roles: RoleCard[] = [
    { id: "heading", icon: FileTextIcon, style: heading },
    { id: "body", icon: FileTextIcon, style: body },
    { id: "mono", icon: CodeIcon, style: mono },
    { id: "symbol", icon: FileTextIcon, style: symbol },
  ];
  const documentPreviewStyle = {
    ...(heading ? typographyThemeStylePreviewStyle(heading, "h3") : {}),
    ...(body ? typographyThemeStylePreviewStyle(body) : {}),
  };
  const codePreviewStyle = codeBlock
    ? typographyThemeStylePreviewStyle(codeBlock, "code-block")
    : undefined;

  return (
    <Stack data-testid="editor-fonts-tab">
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={2}>
            {i18n.t("admin.typography.editor-fonts.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.typography.editor-fonts.description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <Table aria-label={i18n.t("admin.typography.editor-fonts.title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{i18n.t("admin.typography.catalog.styles")}</TableHead>
              <TableHead>{i18n.t("admin.typography.field.family")}</TableHead>
              <TableHead>{i18n.t("admin.typography.field.weight")}</TableHead>
              <TableHead>{i18n.t("admin.typography.field.size")}</TableHead>
              <TableHead>
                {i18n.t("admin.typography.field.line-height")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.typography.font-library.label.assets")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map(({ id, icon: Icon, style }) => {
              const family = fontFamilies.find(
                (candidate) =>
                  candidate.slug === style?.fontFamilySlug ||
                  candidate.displayName === style?.fontFamily,
              );
              const status = assetStatus(family);
              return (
                <TableRow key={id} data-testid={`editor-fonts-role-${id}`}>
                  <TableCell>
                    <Group>
                      <Icon aria-hidden="true" />
                      <Stack gap="var(--mantine-spacing-2xs)">
                        {i18n.t(
                          `admin.typography.editor-fonts.role.${id}` as never,
                        )}
                        <SettingsListItemMeta>
                          {style?.styleKey ?? "-"}
                        </SettingsListItemMeta>
                      </Stack>
                    </Group>
                  </TableCell>
                  <TableCell>{style?.fontFamily ?? "-"}</TableCell>
                  <TableCell>{String(style?.fontWeight ?? "-")}</TableCell>
                  <TableCell>
                    {formatOptionalNumber(style?.sizePx, "px")}
                  </TableCell>
                  <TableCell>
                    {formatOptionalNumber(style?.lineHeight)}
                  </TableCell>
                  <TableCell>
                    <Badge tone={statusTone(status)}>
                      {i18n.t(
                        `admin.typography.editor-fonts.asset.${status}` as never,
                      )}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Stack>

      <ResponsiveGrid cols={{ base: 1, lg: 2 }}>
        <SettingsSection
          component="section"
          title={i18n.t("admin.typography.editor-fonts.document-preview")}
          data-admin-visual-role="authoring-preview"
        >
          <AuthoringTypographyPreview style={documentPreviewStyle}>
            <SettingsListItemMeta>
              {i18n.t("admin.typography.editor-fonts.document-preview")}
            </SettingsListItemMeta>
            <AuthoringTypographyHeading
              data-testid="editor-fonts-heading-preview"
              level={3}
            >
              {i18n.t("admin.typography.editor-fonts.preview-heading")}
            </AuthoringTypographyHeading>
            <AuthoringTypographyText data-testid="editor-fonts-body-preview">
              {i18n.t("admin.typography.editor-fonts.preview-body")}
            </AuthoringTypographyText>
          </AuthoringTypographyPreview>
        </SettingsSection>

        <SettingsSection
          component="section"
          title={i18n.t("admin.typography.editor-fonts.code-preview")}
          data-admin-visual-role="authoring-preview"
        >
          <AuthoringTypographyPreview style={codePreviewStyle}>
            <SettingsListItemMeta>
              {i18n.t("admin.typography.editor-fonts.code-preview")}
            </SettingsListItemMeta>
            <AuthoringTypographyCode
              data-testid="editor-fonts-code-preview"
              variant="block"
            >
              {PREVIEW_CODE}
            </AuthoringTypographyCode>
          </AuthoringTypographyPreview>
        </SettingsSection>
      </ResponsiveGrid>
    </Stack>
  );
}
