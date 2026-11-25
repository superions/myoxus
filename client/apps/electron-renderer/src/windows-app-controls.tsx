// SPDX-License-Identifier: AGPL-3.0-or-later

import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  CopyIcon,
  MinusIcon,
  SquareIcon,
} from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  AppWindowControlButton,
  AppWindowControlsRoot,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

export const WindowsAppControls = () => {
  const desktopApi = useService(DesktopApiService);
  const t = useI18n();

  const handleMinimizeApp = useCallback(() => {
    desktopApi.handler.ui.handleMinimizeApp().catch((err) => {
      console.error(err);
    });
  }, [desktopApi.handler.ui]);
  const handleMaximizeApp = useCallback(() => {
    desktopApi.handler.ui.handleMaximizeApp().catch((err) => {
      console.error(err);
    });
  }, [desktopApi.handler.ui]);
  const handleCloseApp = useCallback(() => {
    desktopApi.handler.ui.handleCloseApp().catch((err) => {
      console.error(err);
    });
  }, [desktopApi.handler.ui]);

  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    return desktopApi.events.ui.onMaximized(setMaximized);
  }, [desktopApi.events.ui]);

  useEffect(() => {
    return desktopApi.events.ui.onFullScreen(setFullscreen);
  }, [desktopApi.events.ui]);

  const isExpanded = maximized || fullscreen;

  return (
    <AppWindowControlsRoot>
      <AppWindowControlButton
        aria-label={t["com.myoxus.desktop.window-controls.minimize"]()}
        control="minimize"
        onClick={handleMinimizeApp}
      >
        <MinusIcon aria-hidden="true" />
      </AppWindowControlButton>
      <AppWindowControlButton
        aria-label={
          isExpanded
            ? t["com.myoxus.desktop.window-controls.restore"]()
            : t["com.myoxus.desktop.window-controls.maximize"]()
        }
        control="maximize"
        onClick={handleMaximizeApp}
      >
        {isExpanded ? (
          <CopyIcon aria-hidden="true" />
        ) : (
          <SquareIcon aria-hidden="true" />
        )}
      </AppWindowControlButton>
      <AppWindowControlButton
        aria-label={t["com.myoxus.desktop.window-controls.close"]()}
        control="close"
        onClick={handleCloseApp}
      >
        <CloseIcon aria-hidden="true" />
      </AppWindowControlButton>
    </AppWindowControlsRoot>
  );
};
