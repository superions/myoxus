// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  ExceptionBoundaryFrame,
  ExceptionBoundarySurface,
  Box,
  MyoxusButton,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "@myoxus/ui-facade";
import { type PropsWithChildren, useSyncExternalStore } from "react";

import {
  getRuntimeThemeProjectionSource,
  reloadRuntimeTheme,
  subscribeRuntimeThemeProjection,
} from "./runtime-theme";

/** Do not present an unthemed workspace as a successfully loaded application. */
export function RuntimeThemeSurface({ children }: PropsWithChildren) {
  const t = useI18n();
  const source = useSyncExternalStore(
    subscribeRuntimeThemeProjection,
    getRuntimeThemeProjectionSource,
  );
  const ready = source === "api";
  const failed = source === "unavailable";
  return (
    <>
      {/* Preserve editor state during an outage without adding a Workbench layout box. */}
      <Box display={ready ? "contents" : "none"} inert={!ready || undefined}>
        {children}
      </Box>
      {!ready ? (
        <ExceptionBoundaryFrame
          scope="app"
          data-myoxus-ui-role="runtime-theme-boundary"
        >
          <ExceptionBoundarySurface>
            <SettingsSectionHeading level={1}>
              {failed
                ? t["com.myoxus.theme.load-error.title"]()
                : t["Loading"]()}
            </SettingsSectionHeading>
            {failed ? (
              <>
                <SettingsSectionDescription>
                  {t["com.myoxus.theme.load-error.description"]()}
                </SettingsSectionDescription>
                <MyoxusButton
                  data-testid="runtime-theme-retry"
                  onClick={() => void reloadRuntimeTheme()}
                >
                  {t["Retry"]()}
                </MyoxusButton>
              </>
            ) : null}
          </ExceptionBoundarySurface>
        </ExceptionBoundaryFrame>
      ) : null}
    </>
  );
}
