import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { AppThemeService } from "@myoxus/core/modules/theme";
import { useService } from "@myoxus/infra";
import {
  MyoxusThemeModeProvider,
  useMyoxusTheme,
} from "@myoxus/ui-facade/provider";
import { type PropsWithChildren, useEffect } from "react";

function ThemeObserver() {
  const { resolvedTheme, setTheme, theme } = useMyoxusTheme();
  const service = useService(AppThemeService);
  const { preferences } = useUserPreferences();

  useEffect(() => {
    service.appTheme.theme$.next(resolvedTheme);
  }, [resolvedTheme, service.appTheme.theme$]);

  useEffect(() => {
    const colorMode = preferences?.effectiveValues.colorMode;
    if (
      (colorMode === "system" ||
        colorMode === "light" ||
        colorMode === "dark") &&
      colorMode !== theme
    ) {
      setTheme(colorMode);
    }
  }, [preferences?.effectiveValues.colorMode, setTheme, theme]);

  return null;
}

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  return (
    <MyoxusThemeModeProvider
      enableSystem={true}
      defaultTheme="system"
      persist={false}
    >
      {children}
      <ThemeObserver />
    </MyoxusThemeModeProvider>
  );
};
