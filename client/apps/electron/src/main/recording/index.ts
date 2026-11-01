// oxlint-disable typescript/no-var-requires

// Should not load @myoxus/media-capture for unsupported platforms

import path from "node:path";

import type {
  AppGroupInfo as ClientAppGroupInfo,
  RecordingFailure,
} from "@myoxus/desktop-api-contract";
import { shell } from "electron";

import { isMacOS, isWindows } from "../../shared/utils";
import { popupManager } from "../windows-manager/popup";
import { WebContentViewsManager } from "../windows-manager/tab-views";
import { openExternalSafely } from "../security/open-external";
import type { MainHandlerImplementations } from "../type";
import {
  assertRecordingDelivery,
  claimRecordingDelivery,
  updateRecordingDelivery,
  recordingDestination,
  getRecordingDestinations,
  listRecoverableRecordings,
  retryRecording,
  askForMeetingPermission,
  checkMeetingPermissions,
  checkRecordingAvailable,
  disableRecordingFeature,
  getRawAudioBuffers,
  getRecording,
  handleBlockCreationFailed,
  handleBlockCreationSuccess,
  pauseRecording,
  readRecordingFile,
  readyRecording,
  recordingStatus$,
  removeRecording,
  SAVED_RECORDINGS_DIR,
  type SerializedRecordingStatus,
  serializeRecordingStatus,
  setupRecordingFeature,
  startRecording,
  stopRecording,
} from "./feature";
import type { AppGroupInfo } from "./types";

function toNativeAppGroup(appGroup: ClientAppGroupInfo): AppGroupInfo {
  return {
    ...appGroup,
    icon: appGroup.icon ? Buffer.from(appGroup.icon) : undefined,
    apps: appGroup.apps.map((app) => ({
      ...app,
      info: {
        ...app.info,
        icon: Buffer.from(app.info.icon),
      },
    })),
  };
}

function toNativeError(failure: RecordingFailure | undefined) {
  if (!failure) return undefined;
  const error = new Error(failure.message);
  error.name = failure.name ?? "Error";
  error.stack = failure.stack;
  return error;
}

export const recordingHandlers = {
  getRecording: async (_, id: number) => {
    return getRecording(id);
  },
  getCurrentRecording: async () => {
    // not all properties are serializable, so we need to return a subset of the status
    return recordingStatus$.value
      ? serializeRecordingStatus(recordingStatus$.value)
      : null;
  },
  startRecording: async (event, appGroup?: ClientAppGroupInfo | number) => {
    const status = startRecording(
      typeof appGroup === "number" || appGroup === undefined
        ? appGroup
        : toNativeAppGroup(appGroup),
      recordingDestination(
        WebContentViewsManager.instance.getWorkbenchIdFromWebContentsId(
          event.sender.id,
        ),
      ),
    );
    if (status) {
      await popupManager.get("recording").show();
      popupManager.get("recording").browserWindow?.focus();
    }
    return status ? serializeRecordingStatus(status) : null;
  },
  listRecoverableRecordings: async () => listRecoverableRecordings(),
  getRecordingDestinations: async () => getRecordingDestinations(),
  retryRecording: async (_, id, viewId) => retryRecording(id, viewId),
  claimRecordingDelivery: async (event, id) =>
    claimRecordingDelivery(id, event.sender),
  updateRecordingDelivery: async (event, id, delivery, claim) =>
    updateRecordingDelivery(id, event.sender.id, delivery, claim),
  pauseRecording: async (_, id: number) => {
    const status = pauseRecording(id);
    return status ? serializeRecordingStatus(status) : null;
  },
  stopRecording: async (_, id: number) => {
    return (await stopRecording(id)) ?? null;
  },
  getRawAudioBuffers: async (_, id: number, cursor?: number) => {
    return getRawAudioBuffers(id, cursor);
  },
  readRecordingFile: async (_, filepath: string) => {
    return readRecordingFile(filepath);
  },
  // save the encoded recording buffer to the file system
  readyRecording: async (_, id: number, buffer: Uint8Array) => {
    return readyRecording(id, Buffer.from(buffer));
  },
  handleBlockCreationSuccess: async (event, id: number, claim: string) => {
    assertRecordingDelivery(id, event.sender.id, claim);
    return handleBlockCreationSuccess(id);
  },
  handleBlockCreationFailed: async (
    event,
    id: number,
    error?: RecordingFailure,
    claim?: string,
  ) => {
    if (claim) assertRecordingDelivery(id, event.sender.id, claim);
    else {
      const status = recordingStatus$.value;
      if (
        status?.id !== id ||
        (status.status !== "stopped" &&
          !(status.status === "ready" && !status.destination))
      )
        throw new Error(
          "Recording failure does not match the current finalization",
        );
    }
    return handleBlockCreationFailed(id, toNativeError(error));
  },
  removeRecording: async (_, id: number) => {
    return removeRecording(id);
  },
  checkRecordingAvailable: async () => {
    return checkRecordingAvailable();
  },
  setupRecordingFeature: async () => {
    return setupRecordingFeature(true);
  },
  disableRecordingFeature: async () => {
    return disableRecordingFeature();
  },
  checkMeetingPermissions: async () => {
    return checkMeetingPermissions();
  },
  askForMeetingPermission: async (_, type: "screen" | "microphone") => {
    return askForMeetingPermission(type);
  },
  showRecordingPermissionSetting: async (_, type: "screen" | "microphone") => {
    if (isMacOS()) {
      const urlMap = {
        screen: "Privacy_ScreenCapture",
        microphone: "Privacy_Microphone",
      };
      const url = `x-apple.systempreferences:com.apple.preference.security?${urlMap[type]}`;
      return openExternalSafely(url, {
        additionalProtocols: ["x-apple.systempreferences:"],
      });
    }
    if (isWindows() && type === "microphone") {
      return openExternalSafely("ms-settings:privacy-microphone", {
        additionalProtocols: ["ms-settings:"],
      });
    }
    return false;
  },
  showSavedRecordings: async (_, subpath?: string) => {
    const normalizedDir = subpath
      ? path.resolve(SAVED_RECORDINGS_DIR, subpath)
      : SAVED_RECORDINGS_DIR;
    const relative = path.relative(SAVED_RECORDINGS_DIR, normalizedDir);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Invalid recording directory");
    return shell.showItemInFolder(normalizedDir);
  },
} satisfies MainHandlerImplementations["recording"];

export const recordingEvents = {
  onRecordingStatusChanged: (
    fn: (status: SerializedRecordingStatus | null) => void,
  ) => {
    const sub = recordingStatus$.subscribe((status) => {
      fn(status ? serializeRecordingStatus(status) : null);
    });
    return () => {
      try {
        sub.unsubscribe();
      } catch {
        // ignore unsubscribe error
      }
    };
  },
};
