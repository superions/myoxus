import { join } from "node:path";

import { BrowserWindow, nativeTheme, screen, WebContentsView } from "electron";
import { BehaviorSubject, map, shareReplay } from "rxjs";

import { isLinux, isMacOS, isWindows, resourcesPath } from "../../shared/utils";
import { beforeAppQuit, quitAfterAdmission } from "../cleanup";
import { mainWindowOrigin } from "../constants";
import { ensureHelperProcess } from "../helper-process";
import { logger } from "../logger";
import { getRendererAdditionalArguments } from "../renderer-arguments";
import {
  MainWindowStateKey,
  MenubarStateKey,
  MenubarStateSchema,
} from "../shared-state-schema";
import { globalStateStorage } from "../shared-storage/storage";
import { uiSubjects } from "../ui/subject";
import { buildWebPreferences } from "../web-preferences";
import { bindMainWindowState, resolveMainWindowState } from "./window-state";

const IS_DEV: boolean =
  process.env.NODE_ENV === "development" && !process.env.CI;

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

function closeAllWindows() {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      for (const view of w.contentView.children) {
        w.contentView.removeChildView(view);
        if (
          view instanceof WebContentsView &&
          !view.webContents.isDestroyed()
        ) {
          view.webContents.close({ waitForBeforeUnload: false });
        }
      }
      w.destroy();
    }
  });
}

export class MainWindowManager {
  static readonly instance = new MainWindowManager();
  mainWindowReady: Promise<BrowserWindow> | undefined;
  mainWindow$ = new BehaviorSubject<BrowserWindow | undefined>(undefined);

  private hiddenMacWindow: BrowserWindow | undefined;
  private windowStateController:
    ReturnType<typeof bindMainWindowState> | undefined;

  private constructor() {
    beforeAppQuit(async () => {
      try {
        if (this.windowStateController) {
          await this.flushWindowState("application quit");
        }
      } finally {
        this.windowStateController?.dispose();
        this.windowStateController = undefined;
        this.cleanupWindows();
      }
    });
  }

  private async flushWindowState(context: string) {
    try {
      await this.windowStateController?.flush();
    } catch (error) {
      logger.error("failed to persist desktop window state", {
        context,
        error,
      });
      throw error;
    }
  }

  get mainWindow() {
    return this.mainWindow$.value;
  }

  // #region private methods
  private preventMacAppQuit() {
    if (!this.hiddenMacWindow && isMacOS()) {
      this.hiddenMacWindow = new BrowserWindow({
        show: false,
        width: 100,
        height: 100,
        webPreferences: buildWebPreferences(),
      });
      this.hiddenMacWindow.on("close", () => {
        this.cleanupWindows();
      });
    }
  }

  private cleanupWindows() {
    closeAllWindows();
    this.mainWindowReady = undefined;
    this.mainWindow$.next(undefined);
    this.hiddenMacWindow?.destroy();
    this.hiddenMacWindow = undefined;
  }

  private async createMainWindow() {
    logger.info("create window");
    const mainWindowState = resolveMainWindowState(
      globalStateStorage.get(MainWindowStateKey),
      screen,
    );

    const browserWindow = new BrowserWindow({
      titleBarStyle: isMacOS()
        ? "hiddenInset"
        : isWindows()
          ? "hidden"
          : "default",
      ...mainWindowState.bounds,
      autoHideMenuBar: isLinux(),
      minWidth: 640,
      minHeight: 480,
      visualEffectState: "active",
      vibrancy: "under-window",
      // backgroundMaterial: 'mica',
      show: false, // Use 'ready-to-show' event to show window
      webPreferences: buildWebPreferences({
        webgl: true,
      }),
    });
    const helper = await ensureHelperProcess();
    helper.connectMain(browserWindow);

    if (isLinux()) {
      browserWindow.setIcon(join(resourcesPath, "icons/app-icon.png"));
    }

    nativeTheme.themeSource = "light";
    this.windowStateController?.dispose();
    this.windowStateController = bindMainWindowState(
      browserWindow,
      globalStateStorage,
    );
    if (mainWindowState.isFullScreen) {
      browserWindow.setFullScreen(true);
    } else if (mainWindowState.isMaximized) {
      browserWindow.maximize();
    }

    this.bindEvents(browserWindow);
    return browserWindow;
  }

  private bindEvents(mainWindow: BrowserWindow) {
    /**
     * If you install `show: true` then it can cause issues when trying to close the window.
     * Use `show: false` and listener events `ready-to-show` to fix these issues.
     *
     * @see https://github.com/electron/electron/issues/25012
     */
    mainWindow.on("ready-to-show", () => {
      logger.info("main window is ready to show");

      uiSubjects.onMaximized$.next(mainWindow.isMaximized());
      uiSubjects.onFullScreen$.next(mainWindow.isFullScreen());
    });

    let closeInProgress = false;
    mainWindow.on("close", (e) => {
      e.preventDefault();
      if (closeInProgress) return;
      closeInProgress = true;

      const completeClose = async () => {
        const hides =
          isMacOS() ||
          (TraySettingsState.value.enabled &&
            TraySettingsState.value.closeToTray);
        if (!hides) {
          // Destruction triggers window-all-closed. Admit the application quit
          // before cleanup, not a second request to already-disposed renderers.
          await quitAfterAdmission();
          closeInProgress = false;
          return;
        }
        try {
          if (this.windowStateController) {
            await this.flushWindowState("window close");
          }
        } catch {
          // flushWindowState already recorded the actionable failure.
        }

        if (!isMacOS()) {
          mainWindow.hide();
        } else {
          if (mainWindow.isFullScreen()) {
            mainWindow.once("leave-full-screen", () => {
              mainWindow.hide();
            });
            mainWindow.setFullScreen(false);
          } else {
            mainWindow.hide();
          }
        }
        closeInProgress = false;
      };
      completeClose().catch((error) => {
        closeInProgress = false;
        logger.error("failed to close main window", error);
      });
    });

    const refreshBound = (timeout = 0) => {
      setTimeout(() => {
        if (mainWindow.isDestroyed()) return;
        // FIXME: workaround for theme bug in full screen mode
        const size = mainWindow.getSize();
        mainWindow.setSize(size[0] + 1, size[1] + 1);
        mainWindow.setSize(size[0], size[1]);
      }, timeout);
    };

    mainWindow.on("leave-full-screen", () => {
      // seems call this too soon may cause the app to crash
      refreshBound();
      refreshBound(1000);
      uiSubjects.onMaximized$.next(false);
      uiSubjects.onFullScreen$.next(false);
    });

    mainWindow.on("maximize", () => {
      uiSubjects.onMaximized$.next(true);
    });

    mainWindow.on("unmaximize", () => {
      uiSubjects.onMaximized$.next(false);
    });

    // full-screen == maximized in UI on windows
    mainWindow.on("enter-full-screen", () => {
      uiSubjects.onFullScreen$.next(true);
    });

    mainWindow.on("leave-full-screen", () => {
      uiSubjects.onFullScreen$.next(false);
    });
  }
  // #endregion

  async ensureMainWindow(): Promise<BrowserWindow> {
    if (
      !this.mainWindowReady ||
      (await this.mainWindowReady.then((w) => w.isDestroyed()))
    ) {
      this.mainWindowReady = this.createMainWindow();
      this.mainWindow$.next(await this.mainWindowReady);
      this.preventMacAppQuit();
    }
    return this.mainWindowReady;
  }

  /**
   * Init main BrowserWindow. Will create a new window if it's not created yet.
   */
  async initAndShowMainWindow() {
    const mainWindow = await this.ensureMainWindow();

    if (IS_DEV) {
      // do not gain focus in dev mode
      mainWindow.showInactive();
    } else if (
      !TraySettingsState.value.enabled ||
      !TraySettingsState.value.startMinimized
    ) {
      mainWindow.show();
    }

    this.preventMacAppQuit();

    return mainWindow;
  }
}

export async function initAndShowMainWindow() {
  return MainWindowManager.instance.initAndShowMainWindow();
}

/** Return the current main window without changing the application lifecycle. */
export async function getMainWindow() {
  return MainWindowManager.instance.mainWindow;
}

export async function showMainWindow() {
  const window = await MainWindowManager.instance.initAndShowMainWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  window.focus();
  return window;
}

function transformToAppUrl(url: URL) {
  const params = url.searchParams;
  return mainWindowOrigin + url.pathname + "?" + params.toString();
}

/**
 * Open a URL in a hidden window.
 */
export async function openUrlInHiddenWindow(urlObj: URL) {
  const url = transformToAppUrl(urlObj);
  const win = new BrowserWindow({
    width: 1200,
    height: 600,
    webPreferences: buildWebPreferences({
      preload: join(__dirname, "./preload.js"),
      additionalArguments:
        await getRendererAdditionalArguments("hidden-window"),
    }),
    show: BUILD_CONFIG.debug,
  });

  if (BUILD_CONFIG.debug) {
    win.webContents.openDevTools();
  }

  logger.info("loading page at", url);
  win.loadURL(url).catch((e) => {
    logger.error("failed to load url", e);
  });
  return win;
}
