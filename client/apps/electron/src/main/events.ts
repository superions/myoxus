import { ipcMain, powerMonitor, webContents } from "electron";

import {
  MYOXUS_EVENT_CHANNEL_NAME,
  MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME,
} from "../shared/type";
import { applicationMenuEvents } from "./application-menu";
import { beforeAppQuit } from "./cleanup";
import { logger } from "./logger";
import { powerEvents } from "./power";
import { recordingEvents } from "./recording";
import { sharedStorageEvents } from "./shared-storage";
import type { MainEventImplementations } from "./type";
import { uiEvents } from "./ui/events";
import { updaterEvents, updaterSubjects } from "./updater/event";
import { popupEvents } from "./windows-manager/popup";

export const allEvents = {
  applicationMenu: applicationMenuEvents,
  updater: updaterEvents,
  ui: uiEvents,
  sharedStorage: sharedStorageEvents,
  recording: recordingEvents,
  popup: popupEvents,
  power: powerEvents,
} satisfies MainEventImplementations;

const subscriptions = new Map<number, Set<string>>();

function getTargetContents(channel: string) {
  const targets: Electron.WebContents[] = [];
  subscriptions.forEach((channels, id) => {
    if (!channels.has(channel)) return;
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) {
      targets.push(wc);
    }
  });
  return targets;
}

function addSubscription(sender: Electron.WebContents, channel: string) {
  const id = sender.id;
  const set = subscriptions.get(id) ?? new Set<string>();
  set.add(channel);
  if (!subscriptions.has(id)) {
    sender.once("destroyed", () => {
      subscriptions.delete(id);
    });
  }
  subscriptions.set(id, set);
}

function removeSubscription(sender: Electron.WebContents, channel: string) {
  const id = sender.id;
  const set = subscriptions.get(id);
  if (!set) return;
  set.delete(channel);
  if (set.size === 0) {
    subscriptions.delete(id);
  } else {
    subscriptions.set(id, set);
  }
}

export function registerEvents() {
  const unsubs: (() => void)[] = [];

  const onSubscribe = (
    event: Electron.IpcMainEvent,
    action: "subscribe" | "unsubscribe",
    channel: string,
  ) => {
    if (typeof channel !== "string") return;
    if (action === "subscribe") {
      addSubscription(event.sender, channel);
      const updaterSnapshot: Record<string, unknown> = {
        "updater:onUpdateAvailable": updaterSubjects.updateAvailable$.value,
        "updater:onUpdateReady": updaterSubjects.updateReady$.value,
        "updater:onDownloadProgress": updaterSubjects.downloadProgress$.value,
        "updater:onStateChange": updaterSubjects.state$.value,
      };
      if (channel in updaterSnapshot) {
        event.sender.send(
          MYOXUS_EVENT_CHANNEL_NAME,
          channel,
          updaterSnapshot[channel],
        );
      }
      if (channel === "power:power-source") {
        event.sender.send(
          MYOXUS_EVENT_CHANNEL_NAME,
          channel,
          powerMonitor.isOnBatteryPower(),
        );
      }
    } else {
      removeSubscription(event.sender, channel);
    }
  };

  ipcMain.on(MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME, onSubscribe);
  unsubs.push(() =>
    ipcMain.removeListener(MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME, onSubscribe),
  );
  // register events
  for (const [namespace, namespaceEvents] of Object.entries(allEvents)) {
    for (const [key, eventRegister] of Object.entries(namespaceEvents)) {
      const unsubscribe = eventRegister((...args: unknown[]) => {
        const chan = `${namespace}:${key}`;
        logger.debug(
          "[ipc-event]",
          chan,
          args.filter(
            (a) =>
              a !== undefined &&
              typeof a !== "function" &&
              typeof a !== "object",
          ),
        );
        getTargetContents(chan).forEach((wc) => {
          if (!wc.isDestroyed()) {
            wc.send(MYOXUS_EVENT_CHANNEL_NAME, chan, ...args);
          }
        });
      });
      unsubs.push(unsubscribe);
    }
  }

  unsubs.forEach((unsub) => {
    beforeAppQuit(() => {
      unsub();
    });
  });
}
