import { I18n } from "@myoxus/i18n";
import { app, dialog, Menu, webContents } from "electron";
import { PUBLIC_PROJECT_URLS } from "@myoxus-tools/utils/public-urls";

import { isMacOS } from "../../shared/utils";
import { beforeAppQuit } from "../cleanup";
import { logger, revealLogFile } from "../logger";
import { openExternalSafely } from "../security/open-external";
import { uiSubjects } from "../ui/subject";
import { checkForUpdates, getUpdaterState } from "../updater";
import {
  addTab,
  initAndShowMainWindow,
  onTabViewsMetaChanged,
  reloadView,
  showMainWindow,
  switchTab,
  switchToNextTab,
  switchToPreviousTab,
  undoCloseTab,
  WebContentViewsManager,
} from "../windows-manager";
import { popupManager } from "../windows-manager/popup";
import { WorkerManager } from "../worker/pool";
import {
  createDocumentVersionSubmenu,
  refreshDocumentVersionMenuState,
} from "./doc-versions";
import { applicationMenuSubjects } from "./subject";

async function openMenuLink(url: string) {
  try {
    await openExternalSafely(url);
  } catch {
    // This menu also operates before a workspace/renderer notification host exists.
    void dialog
      .showMessageBox({
        type: "error",
        message: I18n.t("com.myoxus.common.operation-failed"),
        detail: I18n.t("com.myoxus.link.open-failed"),
      })
      .catch(() => logger.error("Could not display the external-link failure"));
  }
}

// Unique id for menuitems
const MENUITEM_NEW_PAGE = "myoxus:new-page";

export function createApplicationMenu() {
  const isMac = isMacOS();
  const availability = getUpdaterState().availability;
  const externalMacosInstall =
    availability.state === "disabled" &&
    availability.reason === "external-macos-install";
  const updateLabel = externalMacosInstall
    ? I18n.t("com.myoxus.aboutMyoxus.checkUpdate.title.external-macos-install")
    : availability.state === "enabled"
      ? I18n.t("com.myoxus.aboutMyoxus.checkUpdate.button.check")
      : availability.reason === "externally-managed"
        ? I18n.t(
            "com.myoxus.aboutMyoxus.checkUpdate.subtitle.externally-managed",
          )
        : availability.reason === "portable"
          ? I18n.t("com.myoxus.aboutMyoxus.checkUpdate.subtitle.portable")
          : I18n.t("com.myoxus.aboutMyoxus.checkUpdate.subtitle.disabled");

  // Electron menu cannot be modified
  // You have to copy the complete default menu template event if you want to add a single custom item
  // See https://www.electronjs.org/docs/latest/api/menu#examples
  const template = [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: `About ${app.getName()}`,
                click: async () => {
                  await showMainWindow();
                  applicationMenuSubjects.openInSettingModal$.next({
                    activeTab: "about",
                  });
                },
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    // { role: 'fileMenu' }
    {
      label: "File",
      submenu: [
        {
          id: MENUITEM_NEW_PAGE,
          label: "New Doc",
          accelerator: isMac ? "Cmd+N" : "Ctrl+N",
          click: async () => {
            await initAndShowMainWindow();
            // fixme: if the window is just created, the new page action will not be triggered
            applicationMenuSubjects.newPageAction$.next("page");
          },
        },
        createDocumentVersionSubmenu(),
      ],
    },
    // { role: 'editMenu' }
    {
      label: "Edit",
      submenu: [
        ...(["undo", "redo"] as const).map((action) => ({
          label:
            action === "undo"
              ? I18n.t("Undo")
              : I18n.t("com.myoxus.keyboardShortcuts.redo"),
          accelerator:
            action === "undo"
              ? "CommandOrControl+Z"
              : isMac
                ? "Command+Shift+Z"
                : "Control+Y",
          click: () => {
            const manager = WebContentViewsManager.instance;
            const focused = webContents.getFocusedWebContents();
            if (focused !== manager.activeWorkbenchView?.webContents) {
              focused?.[action]();
              return;
            }
            const tabId = manager.activeWorkbenchId;
            if (tabId) {
              applicationMenuSubjects.editHistory$.next({ action, tabId });
            }
          },
        })),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },
    // { role: 'viewMenu' }
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CommandOrControl+R",
          click() {
            reloadView().catch(console.error);
          },
        },
        {
          role: "windowMenu",
        },
        {
          label: "Open devtools",
          accelerator: isMac ? "Cmd+Option+I" : "Ctrl+Shift+I",
          click: () => {
            const workerContents = Array.from(
              WorkerManager.instance.workers.values(),
            ).map(
              (worker) =>
                [worker.key, worker.browserWindow.webContents] as const,
            );

            const tabs = Array.from(
              WebContentViewsManager.instance.tabViewsMap,
            ).map((view) => {
              const isActive = WebContentViewsManager.instance.isActiveTab(
                view[0],
              );
              return [
                view[0] + (isActive ? " (active)" : ""),
                view[1].webContents,
              ] as const;
            });

            const popups = Array.from(popupManager.popupWindows$.value.values())
              .filter((popup) => popup.browserWindow)
              .map((popup) => {
                // oxlint-disable-next-line no-non-null-assertion
                return [popup.type, popup.browserWindow!.webContents] as const;
              });

            const allWebContents = [
              ["tabs", tabs],
              ["workers", workerContents],
              ["popups", popups],
            ] as const;

            Menu.buildFromTemplate(
              allWebContents.flatMap(([type, contents]) => {
                return [
                  {
                    label: type,
                    enabled: false,
                  },
                  ...contents.map(([id, webContents]) => ({
                    label: id,
                    click: () => {
                      webContents.openDevTools({
                        mode: "undocked",
                      });
                    },
                  })),
                  { type: "separator" },
                ];
              }),
            ).popup();
          },
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        ...(!isMacOS()
          ? [{ role: "zoomIn", accelerator: "Ctrl+=", visible: false }]
          : []),
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "New tab",
          accelerator: "CommandOrControl+T",
          click() {
            logger.info("New tab with shortcut");
            addTab().catch(console.error);
          },
        },
        {
          label: "Close view",
          accelerator: "CommandOrControl+W",
          click() {
            logger.info("Close view with shortcut");
            // tell the active workbench to close the current view
            uiSubjects.onCloseView$.next();
          },
        },
        {
          label: "Undo close tab",
          accelerator: "CommandOrControl+Shift+T",
          click() {
            logger.info("Undo close tab with shortcut");
            undoCloseTab().catch(console.error);
          },
        },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
          const shortcut = `CommandOrControl+${n}`;
          const listener = () => {
            switchTab(n);
          };
          return {
            acceleratorWorksWhenHidden: true,
            label: `Switch to tab ${n}`,
            accelerator: shortcut,
            click: listener,
            visible: false,
          };
        }),
        {
          label: "Switch to next tab",
          accelerator: "Control+Tab",
          click: () => {
            switchToNextTab();
          },
        },
        {
          label: "Switch to previous tab",
          accelerator: "Control+Shift+Tab",
          click: () => {
            switchToPreviousTab();
          },
        },
        {
          label: "Switch to next tab (mac 2)",
          accelerator: "Alt+Command+]",
          visible: false,
          click: () => {
            switchToNextTab();
          },
        },
        {
          label: "Switch to previous tab (mac 2)",
          accelerator: "Alt+Command+[",
          visible: false,
          click: () => {
            switchToPreviousTab();
          },
        },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Learn More",
          click: async () => {
            await openMenuLink(PUBLIC_PROJECT_URLS.repository);
          },
        },
        {
          label: "Open log file",
          click: async () => {
            await revealLogFile();
          },
        },
        {
          label: updateLabel,
          enabled: externalMacosInstall || availability.state === "enabled",
          click: async () => {
            if (externalMacosInstall) {
              // External replacement must also work before a workspace is open.
              await openMenuLink(PUBLIC_PROJECT_URLS.downloads);
              return;
            }
            await initAndShowMainWindow();
            await checkForUpdates();
          },
        },
        {
          label: "Documentation",
          click: async () => {
            await openMenuLink(PUBLIC_PROJECT_URLS.documentation);
          },
        },
      ],
    },
  ];

  // @ts-expect-error: The snippet is copied from Electron official docs.
  //                   It's working as expected. No idea why it contains type errors.
  //                   Just ignore for now.
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  refreshDocumentVersionMenuState(menu);
  const unsubscribeDocumentVersionMenu = onTabViewsMetaChanged(() => {
    refreshDocumentVersionMenuState(menu);
  });
  beforeAppQuit(unsubscribeDocumentVersionMenu);

  return menu;
}
