// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Rectangle } from "electron";

import {
  MainWindowStateKey,
  type MainWindowStateSchema as MainWindowState,
  MainWindowStateSchema,
} from "../shared-state-schema";
import type { DesktopStateStorage } from "../shared-storage/storage";

export interface DisplayStateSource {
  getPrimaryDisplay(): { workArea: Rectangle };
  getDisplayMatching(bounds: Rectangle): { workArea: Rectangle };
}

export interface WindowStateTarget {
  getNormalBounds(): Rectangle;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 800;

function intersectionArea(left: Rectangle, right: Rectangle) {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  return width * height;
}

function centeredDefault(workArea: Rectangle): MainWindowState {
  const width = Math.min(DEFAULT_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_HEIGHT, workArea.height);
  return {
    bounds: {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    },
    isMaximized: false,
    isFullScreen: false,
  };
}

function clampBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(Math.max(bounds.width, MIN_WIDTH), workArea.width);
  const height = Math.min(Math.max(bounds.height, MIN_HEIGHT), workArea.height);
  return {
    x: Math.min(
      Math.max(bounds.x, workArea.x),
      workArea.x + workArea.width - width,
    ),
    y: Math.min(
      Math.max(bounds.y, workArea.y),
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  };
}

export function resolveMainWindowState(
  stored: unknown,
  displays: DisplayStateSource,
): MainWindowState {
  const parsed = MainWindowStateSchema.safeParse(stored);
  if (!parsed.success)
    return centeredDefault(displays.getPrimaryDisplay().workArea);

  const display = displays.getDisplayMatching(parsed.data.bounds);
  if (intersectionArea(parsed.data.bounds, display.workArea) === 0) {
    return centeredDefault(displays.getPrimaryDisplay().workArea);
  }
  return {
    bounds: clampBounds(parsed.data.bounds, display.workArea),
    isMaximized: parsed.data.isMaximized,
    isFullScreen: parsed.data.isFullScreen,
  };
}

export function bindMainWindowState(
  window: WindowStateTarget,
  storage: DesktopStateStorage,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const persist = () => {
    if (window.isDestroyed()) return;
    storage.set(MainWindowStateKey, {
      bounds: window.getNormalBounds(),
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
    } satisfies MainWindowState);
  };
  const persistNormalBounds = () => {
    if (window.isMaximized() || window.isFullScreen()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      persist();
    }, 100);
  };
  const persistStatus = () => persist();

  window.on("move", persistNormalBounds);
  window.on("resize", persistNormalBounds);
  window.on("maximize", persistStatus);
  window.on("unmaximize", persistStatus);
  window.on("enter-full-screen", persistStatus);
  window.on("leave-full-screen", persistStatus);

  return {
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      persist();
      await storage.flush();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      window.removeListener("move", persistNormalBounds);
      window.removeListener("resize", persistNormalBounds);
      window.removeListener("maximize", persistStatus);
      window.removeListener("unmaximize", persistStatus);
      window.removeListener("enter-full-screen", persistStatus);
      window.removeListener("leave-full-screen", persistStatus);
    },
  };
}
