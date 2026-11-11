import { I18n } from "@myoxus/i18n";
import { Menu } from "electron";

import { logger } from "../logger";
import {
  addTab,
  closeTab,
  reloadView,
  type TabAction,
  WebContentViewsManager,
} from "./tab-views";

export const showTabContextMenu = async (
  tabId: string,
  viewIndex: number,
): Promise<TabAction | null> => {
  const workbenches = WebContentViewsManager.instance.tabViewsMeta.workbenches;
  const tabMeta = workbenches.find((w) => w.id === tabId);
  if (!tabMeta) {
    return null;
  }

  const { resolve, promise } = Promise.withResolvers<TabAction | null>();

  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    tabMeta.pinned
      ? {
          label: I18n.t("com.myoxus.multi-tab.unpin"),
          click: () => {
            WebContentViewsManager.instance.pinTab(tabId, false);
          },
        }
      : {
          label: I18n.t("com.myoxus.multi-tab.pin"),
          click: () => {
            WebContentViewsManager.instance.pinTab(tabId, true);
          },
        },
    {
      label: I18n.t("com.myoxus.multi-tab.refresh"),
      click: () => {
        reloadView().catch((err) => logger.error(err));
      },
    },
    {
      label: I18n.t("com.myoxus.multi-tab.duplicate"),
      click: () => {
        addTab({
          basename: tabMeta.basename,
          view: tabMeta.views,
          show: false,
        }).catch((err) => logger.error(err));
      },
    },

    { type: "separator" },

    tabMeta.views.length > 1
      ? {
          label: I18n.t("com.myoxus.multi-tab.separate"),
          click: () => {
            WebContentViewsManager.instance.separateView(tabId, viewIndex);
          },
        }
      : {
          label: I18n.t("com.myoxus.workbench.split-view.page-menu-open"),
          click: () => {
            WebContentViewsManager.instance.openInSplitView({ tabId });
          },
        },

    ...(workbenches.length > 1
      ? ([
          { type: "separator" },
          {
            label: I18n.t("com.myoxus.multi-tab.close"),
            click: () => {
              closeTab(tabId).catch((err) => logger.error(err));
            },
          },
          {
            label: I18n.t("com.myoxus.multi-tab.close-others"),
            click: () => {
              const tabsToRetain =
                WebContentViewsManager.instance.tabViewsMeta.workbenches.filter(
                  (w) => w.id === tabId || w.pinned,
                );

              WebContentViewsManager.instance.patchTabViewsMeta({
                workbenches: tabsToRetain,
                activeWorkbenchId: tabId,
              });
            },
          },
        ] as const)
      : []),
  ];
  const menu = Menu.buildFromTemplate(template);
  menu.popup();
  let unsub: (() => void) | undefined;
  const subscription = WebContentViewsManager.instance.tabAction$.subscribe(
    (action) => {
      resolve(action);
      unsub?.();
    },
  );
  menu.on("menu-will-close", () => {
    setTimeout(() => {
      resolve(null);
      unsub?.();
    });
  });
  unsub = () => {
    subscription.unsubscribe();
  };
  return promise;
};
