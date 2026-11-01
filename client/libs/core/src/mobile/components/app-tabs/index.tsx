import { GlobalCacheService } from "@myoxus/core/modules/storage";
import {
  WorkbenchLink,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { useLiveData, useService } from "@myoxus/infra";
import { MobileAppTabsList, MobileAppTabsRoot } from "@myoxus/ui-facade";
import React, { useEffect } from "react";
import { createPortal } from "react-dom";

import { VirtualKeyboardService } from "../../modules/virtual-keyboard/services/virtual-keyboard";
import { cacheKey } from "./constants";
import { tabs } from "./data";
import { TabItem } from "./tab-item";
import type { AppTabLink } from "./type";

export const AppTabs = ({
  background,
  fixed = true,
}: {
  background?: string;
  fixed?: boolean;
}) => {
  const virtualKeyboardService = useService(VirtualKeyboardService);
  const virtualKeyboardVisible = useLiveData(virtualKeyboardService.visible$);
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const globalCache = useService(GlobalCacheService).globalCache;

  // always set the active tab to home when the location is changed to home
  useEffect(() => {
    if (location.pathname === "/home") {
      globalCache.set(cacheKey, "home");
    }
  }, [globalCache, location.pathname]);

  const tab = (
    <MobileAppTabsRoot
      id="app-tabs"
      background={background}
      fixed={fixed}
      hidden={virtualKeyboardVisible}
    >
      <MobileAppTabsList>
        {tabs.map((tab) => {
          if ("to" in tab) {
            return <AppTabLink route={tab} key={tab.key} />;
          } else {
            return (
              <React.Fragment key={tab.key}>
                {<tab.custom tab={tab} />}
              </React.Fragment>
            );
          }
        })}
      </MobileAppTabsList>
    </MobileAppTabsRoot>
  );

  return fixed ? createPortal(tab, document.body) : tab;
};

const AppTabLink = ({ route }: { route: AppTabLink }) => {
  const Link = route.LinkComponent || WorkbenchLink;

  return (
    <TabItem
      component={Link}
      id={route.key}
      label={route.to.slice(1)}
      replaceHistory
      to={route.to}
    >
      <route.Icon />
    </TabItem>
  );
};
