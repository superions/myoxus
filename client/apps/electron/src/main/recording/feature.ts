/* oxlint-disable no-var-requires */
import type {
  RecordingDestination,
  RecordingDelivery,
} from "@myoxus/desktop-api-contract";
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Should not load @myoxus/media-capture for unsupported platforms
import type { ShareableContent as ShareableContentType } from "@myoxus/media-capture";
import { app, systemPreferences, type WebContents } from "electron";
import { debounce } from "lodash-es";
import {
  BehaviorSubject,
  distinctUntilChanged,
  groupBy,
  interval,
  mergeMap,
  Subject,
  throttleTime,
} from "rxjs";
import { filter, map, shareReplay } from "rxjs/operators";

import { isLinux, isMacOS, isWindows, shallowEqual } from "../../shared/utils";
import { beforeAppQuit } from "../cleanup";
import { logger } from "../logger";
import { registeredDesktopServer } from "../server-routing";
import { WebContentViewsManager } from "../windows-manager/tab-views";
import { RecordingRecoveryStore } from "./recovery";
import {
  bindRecordingDeliveryLifetime,
  createRecordingCompletionTimeout,
} from "./delivery-lifetime";
import { deriveRecordingDestination } from "./destination";
import {
  MeetingSettingsKey,
  MeetingSettingsSchema,
} from "../shared-state-schema";
import { globalStateStorage } from "../shared-storage/storage";
import { showMainWindow } from "../windows-manager";
import { popupManager } from "../windows-manager/popup";
import { isAppNameAllowed } from "./allow-list";
import { isFinalizedIsoBmff } from "./iso-bmff";
import { recordingStateMachine } from "./state-machine";
import type {
  AppGroupInfo,
  Recording,
  RecordingStatus,
  TappableAppInfo,
} from "./types";

export const MeetingsSettingsState = {
  $: globalStateStorage.watch<MeetingSettingsSchema>(MeetingSettingsKey).pipe(
    map((v) => MeetingSettingsSchema.parse(v ?? {})),
    shareReplay(1),
  ),

  get value() {
    return MeetingSettingsSchema.parse(
      globalStateStorage.get(MeetingSettingsKey) ?? {},
    );
  },

  set value(value: MeetingSettingsSchema) {
    globalStateStorage.set(MeetingSettingsKey, value);
  },
};

const subscribers: Subscriber[] = [];

// recordings are saved in the app data directory
// may need a way to clean up old recordings
export const SAVED_RECORDINGS_DIR = path.join(
  app.getPath("sessionData"),
  "recordings",
);

let shareableContent: ShareableContentType | null = null;
const completionTimeout = createRecordingCompletionTimeout((id) => {
  const current = recordingStatus$.value;
  if (current?.id === id && current.status === "create-block-success")
    popupManager
      .get("recording")
      .hide()
      .catch((error) => logger.error("Failed to hide saved recording", error));
});

function cleanup() {
  shareableContent = null;
  completionTimeout.clear();
  subscribers.splice(0).forEach((subscriber) => {
    try {
      subscriber.unsubscribe();
    } catch (error) {
      logger.error("Failed to stop recording listeners", error);
    }
  });
}

beforeAppQuit(async () => {
  const status = recordingStatus$.value;
  if (status && (status.status === "recording" || status.status === "paused"))
    await stopRecording(status.id);
  clearTimeout(deliveryTimer);
  cleanup();
});

export const applications$ = new BehaviorSubject<TappableAppInfo[]>([]);
export const appGroups$ = new BehaviorSubject<AppGroupInfo[]>([]);

export const updateApplicationsPing$ = new Subject<number>();

// recording id -> recording
// recordings will be saved in memory before consumed and created as an audio block to user's doc
const recordings = new Map<number, Recording>();

// there should be only one active recording at a time
// We'll now use recordingStateMachine.status$ instead of our own BehaviorSubject
export const recordingStatus$ = recordingStateMachine.status$;
const recovery = new RecordingRecoveryStore(SAVED_RECORDINGS_DIR, (error) =>
  logger.error("Failed to read recording recovery", error),
);
const deliveryOwners = new Map<
  number,
  {
    senderId: number;
    claim: string;
    dispose: () => void;
  }
>();

function releaseRecordingDelivery(id: number) {
  const owner = deliveryOwners.get(id);
  deliveryOwners.delete(id);
  owner?.dispose();
}
const stopping = new Map<number, Promise<SerializedRecordingStatus | null>>();
const finalizing = new Map<number, Promise<void>>();
for (const id of recovery.records.keys())
  recordingStateMachine.reserveIdentity(id);
const latestRecovery = [...recovery.records.values()]
  .filter((record) => record.status !== "create-block-success")
  .sort((a, b) => b.startTime - a.startTime)[0];
if (latestRecovery)
  recordingStateMachine.restore(recovery.status(latestRecovery.id)!);

/** Main derives authority from the initiating tab. An unresolved/removed server
 * leaves capture local rather than substituting the currently configured default. */
export function recordingDestination(
  viewId?: string,
): RecordingDestination | undefined {
  const manager = WebContentViewsManager.instance;
  const meta = viewId
    ? manager.tabViewsMeta.workbenches.find((view) => view.id === viewId)
    : manager.activeWorkbenchMeta;
  return deriveRecordingDestination(
    meta,
    meta ? (manager.tabViewsMap.get(meta.id)?.webContents.getURL() ?? "") : "",
    meta?.serverId ? registeredDesktopServer(meta.serverId) : undefined,
    MeetingsSettingsState.value.recordingSavingMode,
  );
}

export function getRecordingDestinations() {
  return WebContentViewsManager.instance.tabViewsMeta.workbenches.flatMap(
    (meta) => {
      const destination = recordingDestination(meta.id);
      return destination ? [{ viewId: meta.id, destination }] : [];
    },
  );
}

function persistRecordingStatus(status: RecordingStatus) {
  const existing = recovery.records.get(status.id);
  const live = recordings.get(status.id);
  if (!existing && !live) return;
  recovery.put({
    ...existing,
    id: status.id,
    status: status.status,
    startTime: status.startTime,
    appName: status.appName ?? status.appGroup?.name ?? existing?.appName,
    rawFilename:
      existing?.rawFilename ?? path.basename(String(live!.file.path)),
    encodedFilename: status.filepath?.endsWith(".mp4")
      ? path.basename(status.filepath)
      : existing?.encodedFilename,
    sampleRate: existing?.sampleRate ?? live!.session.sampleRate,
    numberOfChannels: existing?.numberOfChannels ?? live!.session.channels,
    destination: status.destination,
    delivery: status.delivery,
    error: status.error,
  });
}
let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
let timedRecordingId: number | undefined;
recordingStatus$.subscribe((status) => {
  if (status) {
    try {
      persistRecordingStatus(status);
    } catch (error) {
      logger.error("Failed to persist recording recovery", error);
    }
  }
  if (status?.status === "ready") {
    if (timedRecordingId === status.id) return;
    clearTimeout(deliveryTimer);
    timedRecordingId = status.id;
    deliveryTimer = setTimeout(() => {
      if (
        recordingStatus$.value?.id === status.id &&
        recordingStatus$.value.status === "ready"
      ) {
        void handleBlockCreationFailed(
          status.id,
          new Error(
            "Recording delivery did not finish. The local audio is retained; retry saving it.",
          ),
        );
      }
    }, 300000);
  } else {
    clearTimeout(deliveryTimer);
    timedRecordingId = undefined;
  }
});

export function listRecoverableRecordings() {
  return [...recovery.records.values()].map((record) =>
    recovery.status(record.id)!,
  );
}

export async function retryRecording(id: number, destinationViewId?: string) {
  const active = recordingStatus$.value;
  if (
    active &&
    (active.status === "recording" ||
      active.status === "paused" ||
      stopping.has(active.id) ||
      finalizing.has(active.id))
  )
    throw new Error("Stop the active recording before retrying a saved file");
  // A failed manifest write must not strand audio once storage is writable again.
  if (active?.id === id && recordings.has(id)) persistRecordingStatus(active);
  const status = recovery.status(id);
  if (!status) throw new Error("Recording is no longer available");
  if (status.status === "create-block-success") {
    recordingStateMachine.restore(status);
    await popupManager.get("recording").show();
    popupManager.get("recording").browserWindow?.focus();
    completionTimeout.schedule(status.id);
    return;
  }
  if (!status.destination && destinationViewId) {
    const destination = recordingDestination(destinationViewId);
    if (!destination)
      throw new Error("The selected destination is unavailable");
    status.destination = destination;
  }
  releaseRecordingDelivery(id);
  status.status = recovery.records.get(id)!.encodedFilename
    ? "ready"
    : "stopped";
  status.error = undefined;
  recordingStateMachine.restore(status);
  await popupManager.get("recording").show();
  popupManager.get("recording").browserWindow?.focus();
}

export function claimRecordingDelivery(id: number, sender: WebContents) {
  const senderId = sender.id;
  logger.info("Recording delivery requested", id, senderId);
  const status = recordingStatus$.value;
  const target = status?.destination;
  if (
    !status ||
    status.id !== id ||
    status.status !== "ready" ||
    !target ||
    deliveryOwners.has(id)
  )
    return null;
  const manager = WebContentViewsManager.instance;
  const viewId = manager.getWorkbenchIdFromWebContentsId(senderId);
  if (!viewId) return null;
  if (
    target.serverId &&
    registeredDesktopServer(target.serverId)?.baseUrl !== target.serverBaseUrl
  ) {
    void handleBlockCreationFailed(
      id,
      new Error(
        "The original recording server is unavailable. Restore that server and retry saving; the local audio is retained.",
      ),
    );
    return null;
  }
  const claim = randomUUID();
  // A full renderer reload loses its pending promise. Fence the old receiver
  // and retain an actionable retry instead of holding a lease until timeout.
  const interrupted = () => {
    if (deliveryOwners.get(id)?.claim !== claim) return;
    releaseRecordingDelivery(id);
    void handleBlockCreationFailed(
      id,
      new Error(
        "The recording window was reloaded or closed while saving. The local audio is retained; retry saving it.",
      ),
    );
  };
  deliveryOwners.set(id, {
    senderId,
    claim,
    dispose: bindRecordingDeliveryLifetime(sender, interrupted),
  });
  logger.info("Recording delivery claimed", id, senderId);
  return claim;
}

export function assertRecordingDelivery(
  id: number,
  senderId: number,
  claim: string,
) {
  const owner = deliveryOwners.get(id);
  if (owner?.senderId !== senderId || owner.claim !== claim)
    throw new Error("Recording delivery is no longer owned by this tab");
}

export function updateRecordingDelivery(
  id: number,
  senderId: number,
  delivery: RecordingDelivery,
  claim: string,
) {
  const status = recordingStatus$.value;
  assertRecordingDelivery(id, senderId, claim);
  if (!status || status.id !== id || status.status !== "ready")
    throw new Error("Recording is no longer ready for delivery");
  if (
    status.delivery &&
    (status.delivery.docId !== delivery.docId ||
      status.delivery.attachmentId !== delivery.attachmentId ||
      (status.delivery.blobId && status.delivery.blobId !== delivery.blobId))
  )
    throw new Error("Recording delivery identity cannot change");
  const next = { ...status, delivery };
  persistRecordingStatus(next);
  recordingStatus$.next(next);
}

function createAppGroup(processGroupId: number): AppGroupInfo | undefined {
  // MUST require dynamically to avoid loading @myoxus/media-capture for unsupported platforms
  const SC: typeof ShareableContentType =
    require("@myoxus/media-capture").ShareableContent;
  const groupProcess = SC?.applicationWithProcessId(processGroupId);
  if (!groupProcess) {
    return;
  }
  return {
    processGroupId: processGroupId,
    apps: [], // leave it empty for now.
    name: groupProcess.name,
    bundleIdentifier: groupProcess.bundleIdentifier,
    // icon should be lazy loaded
    get icon() {
      try {
        return groupProcess.icon;
      } catch (error) {
        logger.error(`Failed to get icon for ${groupProcess.name}`, error);
        return undefined;
      }
    },
    isRunning: false,
  };
}

// pipe applications$ to appGroups$
function setupAppGroups() {
  subscribers.push(
    applications$.pipe(distinctUntilChanged()).subscribe((apps) => {
      const appGroups: AppGroupInfo[] = [];
      apps.forEach((app) => {
        let appGroup = appGroups.find(
          (group) => group.processGroupId === app.processGroupId,
        );

        if (!appGroup) {
          appGroup = createAppGroup(app.processGroupId);
          if (appGroup) {
            appGroups.push(appGroup);
          }
        }
        if (appGroup) {
          appGroup.apps.push(app);
        }
      });

      appGroups.forEach((appGroup) => {
        appGroup.isRunning = appGroup.apps.some((app) => app.isRunning);
      });

      appGroups$.next(appGroups);
    }),
  );
}

function setupNewRunningAppGroup() {
  const appGroupRunningChanged$ = appGroups$.pipe(
    mergeMap((groups) => groups),
    groupBy((group) => group.processGroupId),
    mergeMap((groupStream$) =>
      groupStream$.pipe(
        distinctUntilChanged((prev, curr) => prev.isRunning === curr.isRunning),
      ),
    ),
    filter((group) => isAppNameAllowed(group.name)),
  );

  appGroups$.value.forEach((group) => {
    const recordingStatus = recordingStatus$.value;
    if (
      group.isRunning &&
      MeetingsSettingsState.value.recordingMode === "prompt" &&
      (!recordingStatus || recordingStatus.status === "new")
    ) {
      newRecording(group);
    }
  });

  const debounceStartRecording = debounce((appGroup: AppGroupInfo) => {
    // check if the app is running again
    if (appGroup.isRunning) {
      try {
        startRecording(appGroup, recordingDestination());
      } catch (error) {
        logger.error("Failed to start automatic recording", error);
      }
    }
  }, 1000);
  subscribers.push({ unsubscribe: () => debounceStartRecording.cancel() });

  subscribers.push(
    appGroupRunningChanged$.subscribe((currentGroup) => {
      logger.info(
        "appGroupRunningChanged",
        currentGroup.bundleIdentifier,
        currentGroup.isRunning,
      );

      if (MeetingsSettingsState.value.recordingMode === "none") {
        return;
      }

      const recordingStatus = recordingStatus$.value;

      if (currentGroup.isRunning) {
        // when the app is running and there is no active recording popup
        // we should show a new recording popup
        if (
          !recordingStatus ||
          recordingStatus.status === "new" ||
          recordingStatus.status === "create-block-success"
        ) {
          if (MeetingsSettingsState.value.recordingMode === "prompt") {
            newRecording(currentGroup);
          } else if (
            MeetingsSettingsState.value.recordingMode === "auto-start"
          ) {
            // there is a case that the watched app's running state changed rapidly
            // we will schedule the start recording to avoid that
            debounceStartRecording(currentGroup);
          } else {
            // do nothing, skip
          }
        }
      } else {
        // when displaying in "new" state but the app is not running any more
        // we should remove the recording
        if (
          recordingStatus?.status === "new" &&
          currentGroup.bundleIdentifier ===
            recordingStatus.appGroup?.bundleIdentifier
        ) {
          removeRecording(recordingStatus.id);
        }

        // if the recording is stopped and we are recording it,
        // we should stop the recording
        if (
          recordingStatus?.status === "recording" &&
          recordingStatus.appGroup?.bundleIdentifier ===
            currentGroup.bundleIdentifier
        ) {
          stopRecording(recordingStatus.id).catch((err) => {
            logger.error("failed to stop recording", err);
          });
        }
      }
    }),
  );
}

function getSanitizedAppId(bundleIdentifier?: string) {
  if (!bundleIdentifier) {
    return "unknown";
  }

  // Renderer-supplied app metadata must never become a filesystem path.
  return createHash("sha256")
    .update(bundleIdentifier)
    .digest("hex")
    .substring(0, 8);
}

export function createRecording(status: RecordingStatus) {
  let recording = recordings.get(status.id);
  if (recording) {
    return recording;
  }

  const appId = getSanitizedAppId(status.appGroup?.bundleIdentifier);

  const bufferedFilePath = path.join(
    SAVED_RECORDINGS_DIR,
    `${appId}-${status.id}-${status.startTime}.raw`,
  );

  mkdirSync(SAVED_RECORDINGS_DIR, { recursive: true });
  const file = createWriteStream(bufferedFilePath, {
    mode: 0o600,
    flags: "wx",
  });

  let stream: Recording["session"] | undefined;
  const failCapture = (error: Error) => {
    logger.error("Native recording capture failed", error);
    try {
      stream?.stop();
    } catch (stopError) {
      logger.error("Failed to stop capture after recording error", stopError);
    }
    file.end();
    recordingStateMachine.dispatch({
      type: "CREATE_BLOCK_FAILED",
      id: status.id,
      error,
    });
  };
  file.on("error", failCapture);

  function tapAudioSamples(err: Error | null, samples: Float32Array) {
    const recordingStatus = recordingStatus$.getValue();
    if (
      !recordingStatus ||
      recordingStatus.id !== status.id ||
      recordingStatus.status !== "recording"
    ) {
      return;
    }

    if (err) {
      failCapture(err);
    } else {
      // Writing raw Float32Array samples directly to file
      // For stereo audio, samples are interleaved [L,R,L,R,...]
      file.write(
        Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
      );
    }
  }

  // MUST require dynamically to avoid loading @myoxus/media-capture for unsupported platforms
  const SC: typeof ShareableContentType =
    require("@myoxus/media-capture").ShareableContent;

  try {
    stream =
      status.app && isMacOS()
        ? SC.tapAudio(status.app.processId, tapAudioSamples)
        : SC.tapGlobalAudio(null, tapAudioSamples);
  } catch (error) {
    file.destroy();
    logger.error("Failed to open native audio capture", error);
    throw error;
  }

  recording = {
    id: status.id,
    startTime: status.startTime,
    app: status.app,
    appGroup: status.appGroup,
    file,
    session: stream,
  };

  recordings.set(status.id, recording);

  return recording;
}

export async function getRecording(id: number) {
  const recording = recordings.get(id);
  const recovered = recovery.records.get(id);
  if (!recording && recovered)
    return {
      ...recovered,
      filepath: path.join(SAVED_RECORDINGS_DIR, recovered.rawFilename),
    };
  if (!recording) return;
  const rawFilePath = String(recording.file.path);
  return {
    id,
    appGroup: recording.appGroup,
    app: recording.app,
    startTime: recording.startTime,
    filepath: rawFilePath,
    sampleRate: recording.session.sampleRate,
    numberOfChannels: recording.session.channels,
  };
}

// recording popup status
// new: recording is started, popup is shown
// recording: recording is started, popup is shown
// stopped: recording is stopped, popup showing processing status
// create-block-success: recording is ready, show "open app" button
// create-block-failed: recording is failed, show "failed to save" button
// null: hide popup
function setupRecordingListeners() {
  subscribers.push(
    recordingStatus$
      .pipe(distinctUntilChanged(shallowEqual))
      .subscribe((status) => {
        completionTimeout.clear();
        const popup = popupManager.get("recording");

        if (status && !popup.showing) {
          popup.show().catch((err) => {
            logger.error("failed to show recording popup", err);
          });
        }

        if (status?.status === "create-block-success") {
          completionTimeout.schedule(status.id);
        } else if (!status) {
          // status is removed, we should hide the popup
          popupManager
            .get("recording")
            .hide()
            .catch((err) => {
              logger.error("failed to hide recording popup", err);
            });
        }
      }),
  );
}

function getAllApps(): TappableAppInfo[] {
  if (!shareableContent) {
    return [];
  }

  // MUST require dynamically to avoid loading @myoxus/media-capture for unsupported platforms
  const { ShareableContent } = require("@myoxus/media-capture") as {
    ShareableContent: typeof ShareableContentType;
  };

  const apps = ShareableContent.applications().map((app) => {
    try {
      // Check if this process is actively using microphone/audio
      const isRunning = ShareableContent.isUsingMicrophone(app.processId);

      return {
        info: app,
        processId: app.processId,
        processGroupId: app.processGroupId,
        bundleIdentifier: app.bundleIdentifier,
        name: app.name,
        isRunning,
      };
    } catch (error) {
      logger.error("failed to get app info", error);
      return null;
    }
  });

  const filteredApps = apps.filter(
    (v): v is TappableAppInfo =>
      v !== null &&
      !v.bundleIdentifier.startsWith("com.apple") &&
      !v.bundleIdentifier.startsWith("org.myoxus") &&
      v.processId !== process.pid,
  );
  return filteredApps;
}

type Subscriber = {
  unsubscribe: () => void;
};

function setupMediaListeners() {
  const ShareableContent = require("@myoxus/media-capture").ShareableContent;
  applications$.next(getAllApps());
  if (isLinux()) {
    // Linux exposes a global PipeWire/PulseAudio monitor only. There are no
    // application watchers to poll, and the tray's system-audio action is the
    // explicit recording entry point.
    return;
  }
  subscribers.push(
    interval(3000).subscribe(() => {
      updateApplicationsPing$.next(Date.now());
    }),
    ShareableContent.onApplicationListChanged(() => {
      updateApplicationsPing$.next(Date.now());
    }),
    updateApplicationsPing$
      .pipe(distinctUntilChanged(), throttleTime(3000))
      .subscribe(() => {
        applications$.next(getAllApps());
      }),
  );

  let appStateSubscribers: Subscriber[] = [];
  const clearAppStateSubscribers = () => {
    appStateSubscribers.splice(0).forEach((subscriber) => {
      try {
        subscriber.unsubscribe();
      } catch (error) {
        logger.error("Failed to remove recording app listener", error);
      }
    });
  };
  subscribers.push({ unsubscribe: clearAppStateSubscribers });

  subscribers.push(
    applications$.subscribe((apps) => {
      clearAppStateSubscribers();
      const _appStateSubscribers: Subscriber[] = [];

      apps.forEach((app) => {
        try {
          const applicationInfo = app.info;
          _appStateSubscribers.push(
            ShareableContent.onAppStateChanged(applicationInfo, () => {
              updateApplicationsPing$.next(Date.now());
            }),
          );
        } catch (error) {
          logger.error(
            `Failed to set up app state listener for ${app.name}`,
            error,
          );
        }
      });

      appStateSubscribers = _appStateSubscribers;
    }),
  );
}

function askForScreenRecordingPermission() {
  if (!isMacOS()) {
    return false;
  }
  try {
    const ShareableContent = require("@myoxus/media-capture").ShareableContent;
    // this will trigger the permission prompt
    new ShareableContent();
    return true;
  } catch (error) {
    logger.error("failed to ask for screen recording permission", error);
  }
  return false;
}

// will be called when the app is ready or when the user has enabled the recording feature in settings
export function setupRecordingFeature(
  enabled = MeetingsSettingsState.value.enabled,
) {
  if (!enabled || !checkCanRecordMeeting()) {
    return false;
  }
  if (shareableContent) return true;

  try {
    const ShareableContent = require("@myoxus/media-capture").ShareableContent;
    if (!shareableContent) {
      shareableContent = new ShareableContent();
      setupMediaListeners();
    }
    setupAppGroups();
    setupNewRunningAppGroup();
    setupRecordingListeners();
    return true;
  } catch (error) {
    cleanup();
    logger.error("failed to setup recording feature", error);
    return false;
  }
}

export function disableRecordingFeature() {
  const status = recordingStatus$.value?.status;
  if (status === "recording" || status === "paused" || status === "stopped")
    throw new Error("There is an ongoing recording, please stop it first");
  cleanup();
}

function normalizeAppGroupInfo(
  appGroup?: AppGroupInfo | number,
): AppGroupInfo | undefined {
  if (!isMacOS()) return undefined;
  return typeof appGroup === "number"
    ? appGroups$.value.find((group) => group.processGroupId === appGroup)
    : appGroup;
}

export function newRecording(
  appGroup?: AppGroupInfo | number,
): RecordingStatus | null {
  return recordingStateMachine.dispatch({
    type: "NEW_RECORDING",
    appGroup: normalizeAppGroupInfo(appGroup),
  });
}

export function startRecording(
  appGroup?: AppGroupInfo | number,
  destination?: RecordingDestination,
): RecordingStatus | null {
  const current = recordingStatus$.value;
  if (
    current &&
    current.status !== "new" &&
    current.status !== "create-block-success"
  ) {
    popupManager
      .get("recording")
      .show()
      .then(() => popupManager.get("recording").browserWindow?.focus())
      .catch((error) => logger.error("Failed to focus recording", error));
    return current;
  }
  if (
    !MeetingsSettingsState.value.enabled ||
    !shareableContent ||
    !checkCanRecordMeeting()
  )
    throw new Error("Recording is disabled or native capture is unavailable");
  const state = recordingStateMachine.dispatch(
    { type: "START_RECORDING", appGroup: normalizeAppGroupInfo(appGroup) },
    false,
  );
  if (state?.status === "recording") {
    state.destination = destination;
    try {
      createRecording(state);
      persistRecordingStatus(state);
    } catch (error) {
      const live = recordings.get(state.id);
      try {
        live?.session.stop();
      } catch (stopError) {
        logger.error("Failed to stop recording after setup failure", stopError);
      }
      live?.file.end();
      if (live) {
        recordingStateMachine.restore({
          ...state,
          status: "create-block-failed",
          error:
            error instanceof Error
              ? error.message
              : "Failed to start recording",
        });
      }
      throw error;
    }
  }
  recordingStatus$.next(state);
  return state;
}

export function pauseRecording(id: number) {
  return recordingStateMachine.dispatch({ type: "PAUSE_RECORDING", id });
}

export function resumeRecording(id: number) {
  return recordingStateMachine.dispatch({ type: "RESUME_RECORDING", id });
}

export function stopRecording(
  id: number,
): Promise<SerializedRecordingStatus | null> {
  const previous = stopping.get(id);
  if (previous) return previous;
  const current = recordingStatus$.value;
  if (!current || current.id !== id) return Promise.resolve(null);
  if (current.status !== "recording" && current.status !== "paused")
    return Promise.resolve(serializeRecordingStatus(current));
  const recording = recordings.get(id);
  if (!recording)
    return Promise.reject(new Error("Native recording is unavailable"));
  // Publish only after the original file is flushed; repeated stops share this
  // command, and finalization never reads a partially written tail.
  const operation = (async () => {
    const { file, session } = recording;
    try {
      session.stop();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => done(new Error("File writing timeout")),
          10000,
        );
        const done = (error?: Error) => {
          clearTimeout(timer);
          file.off("finish", finished);
          file.off("error", failed);
          error ? reject(error) : resolve();
        };
        const failed = (error: Error) => done(error);
        const finished = () => {
          try {
            done(
              statSync(file.path).size
                ? undefined
                : new Error("Recording is empty"),
            );
          } catch (error) {
            done(
              error instanceof Error
                ? error
                : new Error("Failed to inspect recording"),
            );
          }
        };
        file.once("finish", finished);
        file.once("error", failed);
        file.end();
      });
      const status = recordingStateMachine.dispatch({
        type: "STOP_RECORDING",
        id,
      });
      return status ? serializeRecordingStatus(status) : null;
    } catch (error) {
      logger.error("Failed to stop recording", error);
      const status = recordingStateMachine.dispatch({
        type: "CREATE_BLOCK_FAILED",
        id,
        error:
          error instanceof Error
            ? error
            : new Error("Failed to stop recording"),
      });
      return status ? serializeRecordingStatus(status) : null;
    } finally {
      if (!file.closed) file.destroy();
    }
  })().finally(() => stopping.delete(id));
  stopping.set(id, operation);
  return operation;
}

export async function getRawAudioBuffers(
  id: number,
  cursor?: number,
): Promise<{
  buffer: Buffer;
  nextCursor: number;
}> {
  const details = await getRecording(id);
  if (!details)
    throw new Error(`getRawAudioBuffers: Recording ${id} not found`);
  const start = cursor ?? 0;
  const file = await fsp.open(details.filepath, "r");
  try {
    const stats = await file.stat();
    if (!Number.isSafeInteger(start) || start < 0 || start > stats.size)
      throw new Error("Invalid recording cursor");
    const buffer = Buffer.alloc(Math.min(stats.size - start, 4 * 1024 * 1024));
    const result = await file.read(buffer, 0, buffer.length, start);
    return {
      buffer: buffer.subarray(0, result.bytesRead),
      nextCursor: start + result.bytesRead,
    };
  } finally {
    await file.close();
  }
}

function assertRecordingFilepath(filepath: string) {
  const normalizedPath = path.resolve(filepath);
  const relative = path.relative(SAVED_RECORDINGS_DIR, normalizedPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Invalid recording filepath");
  }

  return normalizedPath;
}

export async function readRecordingFile(filepath: string) {
  const normalizedPath = assertRecordingFilepath(filepath);
  return fsp.readFile(normalizedPath);
}

export function readyRecording(id: number, buffer: Buffer): Promise<void> {
  if (recovery.records.get(id)?.encodedFilename) return Promise.resolve();
  const previous = finalizing.get(id);
  if (previous) return previous;
  const operation = finalizeRecording(id, buffer).finally(() =>
    finalizing.delete(id),
  );
  finalizing.set(id, operation);
  return operation;
}

async function finalizeRecording(id: number, buffer: Buffer) {
  const status = recordingStatus$.value;
  const record = recovery.records.get(id);
  if (!status || status.id !== id || !record || status.status !== "stopped")
    throw new Error("Recording is not ready for finalization");
  if (!isFinalizedIsoBmff(buffer))
    throw new Error("Recording output is not a finalized ISO BMFF file");
  const filepath = path.join(
    SAVED_RECORDINGS_DIR,
    record.rawFilename.replace(/\.raw$/, ".mp4"),
  );
  const temporary = `${filepath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
    await fsp.rename(temporary, filepath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  // Preserve the original until the user explicitly deletes this recovery.
  // Delivery failures and encoder retries must never discard captured audio.
  recordingStateMachine.dispatch({ type: "SAVE_RECORDING", id, filepath });
  showMainWindow().catch((error) =>
    logger.error("Failed to show recording destination", error),
  );
}

export async function handleBlockCreationSuccess(id: number) {
  releaseRecordingDelivery(id);
  recordingStateMachine.dispatch({
    type: "CREATE_BLOCK_SUCCESS",
    id,
  });
}

export async function handleBlockCreationFailed(id: number, error?: Error) {
  releaseRecordingDelivery(id);
  recordingStateMachine.dispatch({
    type: "CREATE_BLOCK_FAILED",
    id,
    error,
  });
}

export function removeRecording(id: number) {
  const active = recordingStatus$.value;
  if (
    active?.id === id &&
    (active.status === "recording" ||
      active.status === "paused" ||
      stopping.has(id) ||
      finalizing.has(id))
  )
    throw new Error("Stop and finalize the recording before deleting it");
  const live = recordings.get(id);
  if (!recovery.records.has(id) && live) {
    // Explicit deletion also owns a capture whose initial manifest could not be written.
    rmSync(String(live.file.path), { force: true });
    if (active?.id === id && active.filepath?.endsWith(".mp4"))
      rmSync(active.filepath, { force: true });
  }
  recovery.delete(id);
  recordings.delete(id);
  recordingStateMachine.dispatch({ type: "REMOVE_RECORDING", id });
}

export interface SerializedRecordingStatus {
  id: number;
  status: RecordingStatus["status"];
  appName?: string;
  // if there is no app group, it means the recording is for system audio
  appGroupId?: number;
  icon?: Buffer;
  startTime: number;
  filepath?: string;
  sampleRate?: number;
  numberOfChannels?: number;
  destination?: RecordingDestination;
  delivery?: RecordingDelivery;
  error?: string;
}

export function serializeRecordingStatus(
  status: RecordingStatus,
): SerializedRecordingStatus | null {
  const recording = recordings.get(status.id);
  const recovered = recovery.status(status.id);
  return {
    id: status.id,
    status: status.status,
    appName: status.appName ?? status.appGroup?.name ?? recovered?.appName,
    appGroupId: status.appGroup?.processGroupId,
    icon: status.appGroup?.icon,
    startTime: status.startTime,
    filepath:
      status.filepath ??
      recovered?.filepath ??
      (recording ? String(recording.file.path) : undefined),
    sampleRate: recording?.session.sampleRate ?? recovered?.sampleRate,
    numberOfChannels:
      recording?.session.channels ?? recovered?.numberOfChannels,
    destination: status.destination,
    delivery: status.delivery,
    error: status.error,
  };
}

export const getMacOSVersion = () => {
  try {
    const stdout = execSync("sw_vers -productVersion").toString();
    const [major, minor, patch] = stdout.trim().split(".").map(Number);
    return { major, minor, patch };
  } catch (error) {
    logger.error("Failed to get MacOS version", error);
    return { major: 0, minor: 0, patch: 0 };
  }
};

// Platform support is separate from the runtime audio-server probe below.
export const checkRecordingAvailable = () => {
  if (isMacOS()) {
    const version = getMacOSVersion();
    return (version.major === 14 && version.minor >= 2) || version.major > 14;
  }
  if (isWindows()) {
    return true;
  }
  if (isLinux()) {
    return true;
  }
  return false;
};

export const checkMeetingPermissions = () => {
  if (isWindows()) {
    return {
      screen: true,
      // Windows capture includes the global microphone alongside loopback.
      // Electron reads the OS privacy setting for desktop applications.
      microphone:
        systemPreferences.getMediaAccessStatus("microphone") === "granted",
      systemAudio: true,
    };
  }

  if (isLinux()) {
    try {
      const { ShareableContent } = require("@myoxus/media-capture");
      // Constructing ShareableContent performs the native monitor probe and
      // preserves the PulseAudio error for the existing Electron logger.
      new ShareableContent();
      return {
        // Linux system-audio capture does not use screen or microphone
        // privacy prompts. Successful construction is the readiness signal.
        screen: true,
        microphone: true,
        systemAudio: true,
      };
    } catch (error) {
      logger.error("Failed to probe Linux system-audio backend", error);
      return {
        screen: true,
        microphone: true,
        systemAudio: false,
      };
    }
  }

  if (!isMacOS()) {
    return undefined;
  }
  const mediaTypes = ["screen", "microphone"] as const;
  const permissions = Object.fromEntries(
    mediaTypes.map((mediaType) => [
      mediaType,
      systemPreferences.getMediaAccessStatus(mediaType) === "granted",
    ]),
  ) as Record<(typeof mediaTypes)[number], boolean>;
  return { ...permissions, systemAudio: true };
};

export const askForMeetingPermission = async (
  type: "microphone" | "screen",
) => {
  if (!isMacOS()) {
    return false;
  }
  if (type === "screen") {
    return askForScreenRecordingPermission();
  }
  return systemPreferences.askForMediaAccess(type);
};

export const checkCanRecordMeeting = () => {
  const features = checkMeetingPermissions();
  return (
    checkRecordingAvailable() &&
    features &&
    features.systemAudio &&
    Object.values(features).every((feature) => feature)
  );
};
