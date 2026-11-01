/**
 * Typography - server catalog tab.
 *
 * Global typography presets are no longer authored client-side. This tab shows
 * the active Theme DB typography profile/styles and keeps the former preset
 * surface explicitly read-only until a typed server mutation exists.
 */
import { useI18n } from "@myoxus/i18n";
import {
  AuthoringTypographyText,
  SettingsHeadingGroup,
  SettingsSectionDescription,
  SettingsSectionHeading,
  Stack,
  StatCell,
  StatGrid,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";

import { type ThemeDefinition } from "../theme/theme-contract";
import { typographyCatalogStylePreviewStyle } from "./preview-styles";

export function PresetsTab({
  activeTheme,
  headingLevel = 2,
}: {
  activeTheme?: ThemeDefinition | null;
  headingLevel?: 2 | 4;
}) {
  const i18n = useI18n();
  const styles = activeTheme?.typographyStyles ?? [];

  return (
    <Stack>
      <Stack component="section" data-testid="typography-catalog-profile">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={headingLevel}>
            {i18n.t("admin.typography.catalog.profile.kicker")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {activeTheme
              ? i18n.t("admin.typography.catalog.profile.description")
              : i18n.t("admin.typography.catalog.profile.fallback")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <SettingsSectionHeading level={headingLevel === 2 ? 3 : 5}>
          {activeTheme?.name ?? i18n.t("admin.typography.hero.fallback-tokens")}
        </SettingsSectionHeading>
        <StatGrid>
          <StatCell
            label={i18n.t("admin.typography.catalog.theme-slug")}
            value={activeTheme?.slug ?? "-"}
          />
          <StatCell
            label={i18n.t("admin.typography.catalog.typography-slug")}
            value={activeTheme?.typographySlug ?? "-"}
          />
          <StatCell
            label={i18n.t("admin.typography.catalog.styles")}
            value={styles.length}
          />
        </StatGrid>
      </Stack>

      <Stack component="section">
        <SettingsSectionHeading level={headingLevel}>
          {i18n.t("admin.typography.catalog.styles")}
        </SettingsSectionHeading>
        <Table aria-label={i18n.t("admin.typography.catalog.styles")}>
          <TableHeader>
            <TableRow>
              <TableHead>{i18n.t("admin.typography.catalog.styles")}</TableHead>
              <TableHead>{i18n.t("admin.typography.field.family")}</TableHead>
              <TableHead>{i18n.t("admin.typography.field.weight")}</TableHead>
              <TableHead>{i18n.t("admin.typography.field.size")}</TableHead>
              <TableHead>
                {i18n.t("admin.typography.styles.pdf-role")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {styles.map((style) => (
              <TableRow
                key={style.styleKey}
                data-testid={`typography-style-${style.styleKey}`}
              >
                <TableCell>{style.styleKey}</TableCell>
                <TableCell>
                  <AuthoringTypographyText
                    component="span"
                    data-admin-visual-role="authoring-preview"
                    style={typographyCatalogStylePreviewStyle(style)}
                  >
                    {style.fontFamily}
                  </AuthoringTypographyText>
                </TableCell>
                <TableCell>{style.fontWeight}</TableCell>
                <TableCell>{style.sizePx ?? "-"}</TableCell>
                <TableCell>{style.pdfRole ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Stack>
    </Stack>
  );
}
