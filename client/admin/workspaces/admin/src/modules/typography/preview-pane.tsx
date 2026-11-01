/**
 * Typography — global live preview pane.
 *
 * Renders a representative Admin-style document snippet (h1..h5, paragraph,
 * blockquote, link, code) using the live draft tokens, so operators can see
 * the cumulative effect of all four tabs at once.
 */
import { useI18n } from "@myoxus/i18n";
import {
  AuthoringTypographyCode,
  AuthoringTypographyHeading,
  AuthoringTypographyLink,
  AuthoringTypographyPreview,
  AuthoringTypographyQuote,
  AuthoringTypographyText,
  SettingsStatusText,
  Stack,
} from "@myoxus/ui-facade";

import type { ThemeTypographyStyle } from "../theme/theme-contract";
import type { TypographyTokens } from "./api";
import {
  typographyFullPreviewStyle,
  typographyThemeStylePreviewStyle,
} from "./preview-styles";

export function PreviewPane({
  tokens,
  codeBlockStyle,
}: {
  tokens: TypographyTokens;
  codeBlockStyle: ThemeTypographyStyle | null;
}) {
  const i18n = useI18n();
  const previewStyle = {
    ...typographyFullPreviewStyle(tokens),
    ...(codeBlockStyle
      ? typographyThemeStylePreviewStyle(codeBlockStyle, "code-block")
      : typographyThemeStylePreviewStyle(
          {
            styleKey: "code.block",
            fontFamily: tokens.mono.family,
            cssFamily: tokens.mono.cssFamily,
            fontWeight: tokens.mono.weight,
            sizePx: tokens.mono.size,
          },
          "code-block",
        )),
  };

  return (
    <AuthoringTypographyPreview
      data-testid="typography-preview-pane"
      style={previewStyle}
    >
      <SettingsStatusText>
        {i18n.t("admin.typography.preview.title")}
      </SettingsStatusText>
      <Stack>
        <AuthoringTypographyHeading level={1}>
          {i18n.t("admin.typography.preview.h1")}
        </AuthoringTypographyHeading>
        <AuthoringTypographyHeading level={2}>
          {i18n.t("admin.typography.preview.h2")}
        </AuthoringTypographyHeading>
        <AuthoringTypographyText>
          {i18n.t("admin.typography.preview.body")}{" "}
          <AuthoringTypographyLink href="#" onClick={(e) => e.preventDefault()}>
            {i18n.t("admin.typography.preview.link")}
          </AuthoringTypographyLink>
          .
        </AuthoringTypographyText>
        <AuthoringTypographyText variant="bodySmall">
          {i18n.t("admin.typography.preview.body-small")}
        </AuthoringTypographyText>
        <AuthoringTypographyQuote>
          {i18n.t("admin.typography.preview.blockquote")}
        </AuthoringTypographyQuote>
        <AuthoringTypographyCode variant="block">
          {i18n.t("admin.typography.preview.body.code-block")}
        </AuthoringTypographyCode>
      </Stack>
    </AuthoringTypographyPreview>
  );
}
