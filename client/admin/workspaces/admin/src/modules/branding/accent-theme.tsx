/**
 * Keeps Admin's local color-scheme switch aligned with explicit server-owned
 * theme-mode decisions.
 *
 * The actual theme, typography and color tokens are delivered through
 * `/api/branding/theme.css`. Do not project those values as inline styles here:
 * inline `documentElement.style` variables outrank the stylesheet's
 * `[data-theme='dark']` blocks and can make dark-mode form controls unreadable.
 */
import { adminEffectiveThemeProfileQuery } from "@myoxus/graphql";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { useEffect } from "react";

import { useQuery } from "../../use-query";
import { isThemeMode, type ThemeProfile } from "../theme/theme-contract";

function profileFromResponse(data: unknown): ThemeProfile | undefined {
  const admin = (
    data as
      | {
          admin?: { effectiveThemeProfile?: ThemeProfile | null };
        }
      | null
      | undefined
  )?.admin;
  return admin?.effectiveThemeProfile ?? undefined;
}

export function BrandingAccentThemeSync() {
  const { data } = useQuery({
    query: adminEffectiveThemeProfileQuery,
    variables: { workspaceId: null },
  });
  const { theme, setTheme } = useMyoxusTheme();
  const profile = profileFromResponse(data);
  const themeMode = isThemeMode(profile?.themeMode)
    ? profile.themeMode
    : undefined;

  useEffect(() => {
    // Explicit server modes are product state and must drive Admin's local
    // `data-theme`. `system` remains a user/OS-resolved mode and should not
    // rewrite a user's current local light/dark preference on every render.
    if (
      (themeMode === "light" || themeMode === "dark") &&
      theme !== themeMode
    ) {
      setTheme(themeMode);
    }
  }, [setTheme, theme, themeMode]);

  return null;
}
