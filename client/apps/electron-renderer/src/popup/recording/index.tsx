// SPDX-License-Identifier: MIT
import {
  createStreamEncoder,
  encodeRawBufferToOpus,
  type OpusStreamEncoder,
} from "@myoxus/core/utils/opus-encoding";
import { DebugLogger } from "@myoxus/debug";
import type { RecordingStatus } from "@myoxus/desktop-api-contract";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { useI18n } from "@myoxus/i18n";
import { PlayIcon, StopIcon, VoiceIcon } from "@myoxus/icons/react";
import {
  Avatar,
  getBrandAssetUrl,
  Button,
  Group,
  Stack,
  MyoxusText,
  Menu,
  MenuItem,
  MenuTrigger,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";

import * as styles from "./styles";

const bridge = getDesktopBridge();
const apis = bridge?.apis;
const events = bridge?.events;
const logger = new DebugLogger("electron-renderer:recording-popup");
// The singleton native popup can receive both a restored snapshot and events.
// Encoding is owned per recording, independently of React effect replay.
const encoders = new Map<number, OpusStreamEncoder>();
const finalizing = new Map<number, Promise<void>>();

export const useRecordingStatus = () => {
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  useEffect(() => {
    let active = true;
    let observedEvent = false;
    const unsubscribe = events?.recording.onRecordingStatusChanged((status) => {
      observedEvent = true;
      if (active) setStatus(status);
    });
    void apis?.recording
      .getCurrentRecording()
      .then((status) => {
        if (active && !observedEvent) setStatus(status);
      })
      .catch((error) => logger.error("Failed to read recording status", error));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  return status;
};

async function finalize(status: RecordingStatus) {
  if (!apis) throw new Error("Native recording is unavailable");
  const existing = finalizing.get(status.id);
  if (existing) return existing;
  const operation = (async () => {
    try {
      const current = await apis.recording.getCurrentRecording();
      if (current?.id !== status.id || current.status !== "stopped") return;
      if (!current.filepath || !current.sampleRate || !current.numberOfChannels)
        throw new Error("The original recording audio is unavailable");
      const encoder = encoders.get(status.id);
      const buffer = encoder
        ? await encoder.finish()
        : await encodeRawBufferToOpus({
            filepath: current.filepath,
            sampleRate: current.sampleRate,
            numberOfChannels: current.numberOfChannels,
          });
      await apis.recording.readyRecording(status.id, buffer);
    } catch (error) {
      logger.error("Failed to finalize recording", error);
      await apis.recording.handleBlockCreationFailed(status.id, {
        message:
          error instanceof Error
            ? error.message
            : "Failed to finalize recording",
      });
    } finally {
      encoders.delete(status.id);
    }
  })().finally(() => finalizing.delete(status.id));
  finalizing.set(status.id, operation);
  return operation;
}

export function Recording() {
  const status = useRecordingStatus();
  const t = useI18n();
  const [productMark, setProductMark] = useState<string>();
  useEffect(() => {
    let active = true;
    void getBrandAssetUrl("productMark")
      .then((url) => {
        if (active) setProductMark(url);
      })
      .catch((error) =>
        logger.error("Failed to load recording branding", error),
      );
    return () => {
      active = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [destinations, setDestinations] = useState<
    Awaited<
      ReturnType<
        NonNullable<typeof apis>["recording"]["getRecordingDestinations"]
      >
    >
  >([]);
  const [selectedView, setSelectedView] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const perform = useCallback(async (operation: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(undefined);
    try {
      await operation();
    } catch (error) {
      logger.error("Recording action failed", error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!status) return;
    if (
      status.status === "recording" &&
      status.sampleRate &&
      status.numberOfChannels &&
      !encoders.has(status.id)
    ) {
      for (const [id, encoder] of encoders)
        if (id !== status.id) {
          void encoder.close();
          encoders.delete(id);
        }
      const encoder = createStreamEncoder(status.id, {
        sampleRate: status.sampleRate,
        numberOfChannels: status.numberOfChannels,
      });
      encoders.set(status.id, encoder);
      void encoder
        .poll()
        .catch((error) => logger.error("Recording encoder failed", error));
    }
    if (status.status === "stopped")
      void finalize(status).catch((error) =>
        logger.error("Failed to retain recording failure", error),
      );
    if (status.status === "create-block-failed" && !status.destination) {
      void apis?.recording
        .getRecordingDestinations()
        .then(setDestinations)
        .catch((error) =>
          logger.error("Failed to list recording destinations", error),
        );
    }
  }, [status]);
  const recordingId = status?.id;
  const recordingState = status?.status;
  const recordingStartTime = status?.startTime;
  useEffect(() => {
    if (
      recordingId === undefined ||
      recordingStartTime === undefined ||
      (recordingState !== "recording" && recordingState !== "paused")
    )
      return;
    const update = () =>
      setElapsed(
        Math.max(0, Math.floor((Date.now() - recordingStartTime) / 1000)),
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [recordingId, recordingState, recordingStartTime]);

  if (!status || !apis) return null;
  const active = status.status === "recording" || status.status === "paused";
  const processing = status.status === "stopped" || status.status === "ready";
  const label =
    status.status === "new"
      ? t["com.myoxus.recording.state.ready"]()
      : active && !busy
        ? t["com.myoxus.recording.state.recording"]()
        : status.status === "create-block-success"
          ? t["com.myoxus.recording.success.prompt"]()
          : status.status === "create-block-failed"
            ? t["com.myoxus.recording.failed.prompt"]()
            : t["com.myoxus.recording.state.finalizing"]();
  const openRecording = async () => {
    const destination = status.destination;
    const delivery = status.delivery;
    if (!destination || !delivery)
      throw new Error("The saved recording destination is unavailable");
    const candidates = await apis.recording.getRecordingDestinations();
    const tab = candidates.find(
      (candidate) =>
        candidate.destination.workspaceId === destination.workspaceId &&
        candidate.destination.serverId === destination.serverId &&
        candidate.destination.serverBaseUrl === destination.serverBaseUrl,
    );
    if (!tab) throw new Error("Open the original recording workspace first");
    await apis.ui.handleOpenMainApp();
    await apis.ui.showTab(tab.viewId);
    await apis.ui.tabGoTo(tab.viewId, `/${delivery.docId}`);
  };
  return (
    <Stack className={styles.root} data-myoxus-ui-role="recording-popup">
      <Group>
        <Avatar
          url={productMark}
          name="Myoxus"
          data-myoxus-ui-role="recording-product-mark"
        >
          <VoiceIcon />
        </Avatar>
        <MyoxusText>
          {status.appName ??
            (environment.isWindows
              ? t["com.myoxus.recording.source.microphone-system"]()
              : t["com.myoxus.recording.source.system"]())}
        </MyoxusText>
        <MyoxusText role="status" aria-live="polite">
          {label}
        </MyoxusText>
        {active && (
          <MyoxusText role="timer" aria-live="off">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </MyoxusText>
        )}
      </Group>
      <MyoxusText>
        {status.destination
          ? `${status.destination.workspaceName ?? status.destination.workspaceId} · ${status.destination.savingMode === "new-doc" ? t["com.myoxus.empty.docs.action.new-doc"]() : t["com.myoxus.command-center.today-journal"]()}`
          : t["com.myoxus.recording.destination.none"]()}
      </MyoxusText>
      {(actionError || status.error) && (
        <MyoxusText tone="danger">{actionError ?? status.error}</MyoxusText>
      )}
      <Group className={styles.controls}>
        {status.status === "new" && (
          <Button
            variant="primary"
            prefix={<PlayIcon />}
            disabled={busy}
            loading={busy}
            onClick={() =>
              void perform(() =>
                apis.recording.startRecording(status.appGroupId),
              )
            }
          >
            {t["com.myoxus.recording.start"]()}
          </Button>
        )}
        {active && (
          <Button
            variant="error"
            prefix={<StopIcon />}
            loading={busy}
            disabled={busy}
            onClick={() =>
              void perform(() => apis.recording.stopRecording(status.id))
            }
          >
            {t["com.myoxus.recording.stop"]()}
          </Button>
        )}
        {processing && (
          <Button loading disabled>
            {t["com.myoxus.recording.state.finalizing"]()}
          </Button>
        )}
        {status.status === "create-block-success" && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void perform(openRecording)}
          >
            {t["com.myoxus.recording.success.button"]()}
          </Button>
        )}
        {status.status === "create-block-failed" && (
          <>
            {!status.destination && (
              <Menu
                items={destinations.map((candidate) => (
                  <MenuItem
                    key={candidate.viewId}
                    onSelect={() => setSelectedView(candidate.viewId)}
                  >
                    {candidate.destination.workspaceName ??
                      candidate.destination.workspaceId}
                  </MenuItem>
                ))}
              >
                <MenuTrigger>
                  {destinations.find(
                    (candidate) => candidate.viewId === selectedView,
                  )?.destination.workspaceName ??
                    destinations.find(
                      (candidate) => candidate.viewId === selectedView,
                    )?.destination.workspaceId ??
                    t["com.myoxus.recording.destination.select"]()}
                </MenuTrigger>
              </Menu>
            )}
            <Button
              variant="primary"
              disabled={busy || (!status.destination && !selectedView)}
              loading={busy}
              onClick={() =>
                void perform(() =>
                  apis.recording.retryRecording(status.id, selectedView),
                )
              }
            >
              {t["com.myoxus.recording.retry-save"]()}
            </Button>
          </>
        )}
        {(status.status === "create-block-failed" ||
          status.status === "create-block-success") && (
          <Button
            disabled={busy}
            onClick={() =>
              void perform(() =>
                apis.recording.showSavedRecordings(status.filepath),
              )
            }
          >
            {t["com.myoxus.recording.failed.button"]()}
          </Button>
        )}
        {!active && !processing && status.status !== "new" && (
          <Button
            variant="error"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await apis.recording.removeRecording(status.id);
                await apis.popup.dismissCurrentRecording();
              })
            }
          >
            {t["com.myoxus.recording.delete-files"]()}
          </Button>
        )}
        {!active && !processing && (
          <Button
            variant="plain"
            disabled={busy}
            onClick={() =>
              void perform(() => apis.popup.dismissCurrentRecording())
            }
          >
            {t["common.hide"]()}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
