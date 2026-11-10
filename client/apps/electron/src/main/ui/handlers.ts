import { app, nativeImage, nativeTheme, Notification } from "electron";
import { map, shareReplay } from "rxjs";

import { isMacOS } from "../../shared/utils";
import { writePngToClipboard } from "../clipboard";
import { rendererCloseAdmission } from "../close-admission";
import { quitAfterAdmission } from "../cleanup";
import { openExternalSafely } from "../security/open-external";
import {
  MenubarStateKey,
  MenubarStateSchema,
  type WorkbenchViewMeta,
} from "../shared-state-schema";
import { globalStateStorage } from "../shared-storage/storage";
import type { MainHandlerImplementations } from "../type";
import {
  WebContentViewsManager,
  activateView,
  addTab,
  closeTab,
  ensureTabLoaded,
  getMainWindow,
  getOnboardingWindow,
  getTabsStatus,
  getTabViewsMeta,
  getWorkbenchMeta,
  handleWebContentsResize,
  initAndShowMainWindow,
  isActiveTab,
  moveTab,
  pingAppLayoutReady,
  showDevTools,
  showTab,
  updateActiveViewMeta,
  updateWorkbenchMeta,
  updateWorkbenchViewMeta,
} from "../windows-manager";
import { showTabContextMenu } from "../windows-manager/context-menu";
import { completeOnboarding } from "../windows-manager/onboarding-state";
import { getBookmarkDataByLink } from "./bookmark-data";
import { getChallengeResponse } from "./challenge";
import { savePdf } from "./save-pdf";
import { saveExportFile } from "./save-file-export";
import { uiSubjects } from "./subject";

const TraySettingsState = {
  $: globalStateStorage.watch<MenubarStateSchema>(MenubarStateKey).pipe(
    map((v) => MenubarStateSchema.parse(v ?? {})),
    shareReplay(1),
  ),

  get value() {
    return MenubarStateSchema.parse(
      globalStateStorage.get(MenubarStateKey) ?? {},
    );
  },
};

export const uiHandlers = {
  invalidateBranding: async (event) => {
    // Main resolves the source tab; renderers cannot invalidate another server.
    const id = WebContentViewsManager.instance.getWorkbenchIdFromWebContentsId(
      event.sender.id,
    );
    const serverId = id ? getWorkbenchMeta(id)?.serverId : undefined;
    if (serverId) uiSubjects.onBrandingUpdated$.next({ serverId });
  },
  savePdf: (event, filename, bytes) => savePdf(event.sender, filename, bytes),
  saveExportFile: (event, format, filename, bytes) =>
    saveExportFile(event.sender, format, filename, bytes),
  isMaximized: async () => {
    const window = await getMainWindow();
    return window?.isMaximized();
  },
  isFullScreen: async () => {
    const window = await getMainWindow();
    return window?.isFullScreen();
  },
  handleThemeChange: async (_, theme: (typeof nativeTheme)["themeSource"]) => {
    nativeTheme.themeSource = theme;
  },
  handleMinimizeApp: async () => {
    const window = await getMainWindow();
    if (
      TraySettingsState.value.enabled &&
      TraySettingsState.value.minimizeToTray
    ) {
      window?.hide();
    } else {
      window?.minimize();
    }
  },
  handleMaximizeApp: async () => {
    const window = await getMainWindow();
    if (!window) {
      return;
    }
    // allow unmaximize when in full screen mode
    if (window.isFullScreen()) {
      window.setFullScreen(false);
      window.unmaximize();
    } else if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  },
  handleWindowResize: async (e) => {
    await handleWebContentsResize(e.sender);
  },
  handleCloseApp: async () => {
    if (
      TraySettingsState.value.enabled &&
      TraySettingsState.value.closeToTray
    ) {
      const window = await getMainWindow();
      window?.hide();
    } else {
      app.quit();
    }
  },
  handleHideApp: async () => {
    const window = await getMainWindow();
    window?.hide();
  },
  getChallengeResponse: async (_, challenge: string) => {
    return getChallengeResponse(challenge);
  },
  handleOpenMainApp: async () => {
    await completeOnboarding(globalStateStorage);
    const onboarding = await getOnboardingWindow();
    onboarding?.hide();
    await initAndShowMainWindow();
    // Destroy only after the durable state and main window are ready.
    onboarding?.destroy();
  },
  getBookmarkDataByLink: (_, link: string) => getBookmarkDataByLink(link),
  openExternal(_, url: string) {
    return openExternalSafely(url);
  },

  // tab handlers
  isActiveTab: async (e) => {
    return isActiveTab(e.sender);
  },
  getWorkbenchMeta: async (_, ...args: Parameters<typeof getWorkbenchMeta>) => {
    return getWorkbenchMeta(...args);
  },
  updateWorkbenchMeta: async (
    _,
    ...args: Parameters<typeof updateWorkbenchMeta>
  ) => {
    return updateWorkbenchMeta(...args);
  },
  updateWorkbenchViewMeta: async (
    _,
    ...args: Parameters<typeof updateWorkbenchViewMeta>
  ) => {
    return updateWorkbenchViewMeta(...args);
  },
  getTabViewsMeta: async () => {
    return getTabViewsMeta();
  },
  updateActiveViewMeta: async (e, meta: Partial<WorkbenchViewMeta>) => {
    return updateActiveViewMeta(e.sender, meta);
  },
  getTabsStatus: async () => {
    return getTabsStatus();
  },
  addTab: async (_, ...args: Parameters<typeof addTab>) => {
    await addTab(...args);
  },
  showTab: async (_, ...args: Parameters<typeof showTab>) => {
    await showTab(...args);
  },
  tabGoTo: async (_, tabId: string, to: string) => {
    uiSubjects.tabGoToRequest$.next({ tabId, to });
  },
  ensureTabLoaded: async (_, ...args: Parameters<typeof ensureTabLoaded>) => {
    await ensureTabLoaded(...args);
  },
  closeTab: async (_, ...args: Parameters<typeof closeTab>) => {
    await closeTab(...args);
  },
  setCloseParticipant: async (event, participantId, participating) => {
    if (!participating)
      return rendererCloseAdmission.unregister(event.sender.id, participantId);
    const tabId =
      WebContentViewsManager.instance.getWorkbenchIdFromWebContentsId(
        event.sender.id,
      );
    if (!tabId) return false;
    return rendererCloseAdmission.register(
      event.sender,
      participantId,
      async () => {
        if (
          event.sender.isDestroyed() ||
          WebContentViewsManager.instance.getWorkbenchIdFromWebContentsId(
            event.sender.id,
          ) !== tabId
        )
          throw new Error("Desktop close participant no longer owns its tab");
        await showTab(tabId);
        const window = await getMainWindow();
        if (!window || window.isDestroyed())
          throw new Error("Desktop close window unavailable");
        window.show();
        window.focus();
      },
    );
  },
  answerCloseRequest: async (event, requestId, participantId, allowed) =>
    rendererCloseAdmission.answer(
      event.sender.id,
      requestId,
      participantId,
      allowed,
    ),

  activateView: async (_, ...args: Parameters<typeof activateView>) => {
    await activateView(...args);
  },
  moveTab: async (_, ...args: Parameters<typeof moveTab>) => {
    moveTab(...args);
  },
  toggleRightSidebar: async (_, tabId?: string) => {
    tabId ??= getTabViewsMeta().activeWorkbenchId;
    if (tabId) {
      uiSubjects.onToggleRightSidebar$.next(tabId);
    }
  },
  pingAppLayoutReady: async (e, ready = true) => {
    pingAppLayoutReady(e.sender, ready);
  },
  showDevTools: async (_, ...args: Parameters<typeof showDevTools>) => {
    return showDevTools(...args);
  },
  showTabContextMenu: async (_, tabKey: string, viewIndex: number) => {
    return showTabContextMenu(tabKey, viewIndex);
  },
  openThemeEditor: async () => {
    // Theme editor removed (P100-WF-F) — no-op to maintain handler contract.
  },
  restartApp: async () => {
    await quitAfterAdmission(() => {
      app.relaunch();
      app.quit();
    });
  },
  showCalendarReminderNotification: async (
    _,
    title: string,
    body: string,
    eventId: string,
    startDate: string,
  ) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on("click", async () => {
      uiSubjects.onCalendarReminderClick$.next({ eventId, startDate });
      const win = await getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    n.show();
  },
  onLanguageChange: async (e, language: string) => {
    // only works for win/linux
    // see https://www.electronjs.org/docs/latest/tutorial/spellchecker#how-to-set-the-languages-the-spellchecker-uses
    if (isMacOS()) {
      return;
    }

    if (e.sender.session.availableSpellCheckerLanguages.includes(language)) {
      e.sender.session.setSpellCheckerLanguages([language, "en-US"]);
    }
  },
  captureArea: async (e, { x, y, width, height }: Electron.Rectangle) => {
    const image = await e.sender.capturePage({
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.floor(width),
      height: Math.floor(height),
    });

    if (image.isEmpty()) {
      throw new Error("Image is empty or invalid");
    }

    const buffer = image.toPNG();
    if (!buffer || !buffer.length) {
      throw new Error("Failed to generate PNG buffer from image");
    }

    await writePngToClipboard(nativeImage.createFromBuffer(buffer));
  },
} satisfies MainHandlerImplementations["ui"];
