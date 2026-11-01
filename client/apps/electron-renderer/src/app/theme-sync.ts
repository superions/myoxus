import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { useService } from "@myoxus/infra";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { useRef } from "react";

export const DesktopThemeSync = () => {
  const { resolvedTheme } = useMyoxusTheme();
  const lastThemeRef = useRef(resolvedTheme);
  const onceRef = useRef(false);

  const handler = useService(DesktopApiService).api.handler;

  if (lastThemeRef.current !== resolvedTheme || !onceRef.current) {
    if (BUILD_CONFIG.isElectron && resolvedTheme) {
      handler.ui.handleThemeChange(resolvedTheme).catch((err) => {
        console.error(err);
      });
    }
    lastThemeRef.current = resolvedTheme;
    onceRef.current = true;
  }
  return null;
};
