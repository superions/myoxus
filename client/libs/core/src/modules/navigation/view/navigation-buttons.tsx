import { useI18n } from "@myoxus/i18n";
import { ArrowLeftSmallIcon, ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { HeaderActionGroup, IconButton } from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

import { NavigatorService } from "../services/navigator";

const tooltipSideBottom = { side: "bottom" as const };

export const NavigationButtons = () => {
  if (!BUILD_CONFIG.isElectron) {
    return null;
  }

  return <ElectronNavigationButtons />;
};

const ElectronNavigationButtons = () => {
  const t = useI18n();

  const navigator = useService(NavigatorService).navigator;

  const backable = useLiveData(navigator.backable$);
  const forwardable = useLiveData(navigator.forwardable$);

  const handleBack = useCallback(() => {
    navigator.back();
  }, [navigator]);

  const handleForward = useCallback(() => {
    navigator.forward();
  }, [navigator]);

  useEffect(() => {
    const cb = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        event.stopPropagation();

        if (event.button === 3) {
          navigator.back();
        } else {
          navigator.forward();
        }
      }
    };
    document.addEventListener("mouseup", cb);
    return () => {
      document.removeEventListener("mouseup", cb);
    };
  }, [navigator]);

  return (
    <HeaderActionGroup data-myoxus-ui-role="electron-navigation-actions">
      <IconButton
        tooltip={t["Go Back"]()}
        tooltipShortcut={["$mod", "["]}
        tooltipOptions={tooltipSideBottom}
        data-testid="app-navigation-button-back"
        disabled={!backable}
        onClick={handleBack}
      >
        <ArrowLeftSmallIcon />
      </IconButton>
      <IconButton
        tooltip={t["Go Forward"]()}
        tooltipShortcut={["$mod", "]"]}
        tooltipOptions={tooltipSideBottom}
        data-testid="app-navigation-button-forward"
        disabled={!forwardable}
        onClick={handleForward}
      >
        <ArrowRightSmallIcon />
      </IconButton>
    </HeaderActionGroup>
  );
};
