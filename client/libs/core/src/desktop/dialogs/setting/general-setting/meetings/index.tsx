import { getArtworkUrl } from "@myoxus/theme/artwork";
import { EmptyState, ThemedImg } from "@myoxus/ui-facade";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { MeetingSettingsService } from "@myoxus/core/modules/media/services/meeting-settings";
import { DebugLogger } from "@myoxus/debug";
import type {
  MeetingSettingsSchema,
  RecordingStatus,
} from "@myoxus/desktop-api-contract";
import { i18nTime, useI18n } from "@myoxus/i18n";
import {
  ArrowRightSmallIcon,
  DoneIcon,
  InformationFillDuotoneIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Button,
  IconButton,
  InlineActionButton,
  Menu,
  MenuItem,
  MenuTrigger,
  SettingHeader,
  SettingRow,
  SettingsStatusText,
  SettingWrapper,
  Stack,
  Switch,
} from "../../primitives";
import { useEnableRecording } from "./use-enable-recording";

const logger = new DebugLogger("meetings-settings");

const recordingModeKeys = {
  prompt: "com.myoxus.settings.meetings.record.recording-mode.prompt",
  "auto-start": "com.myoxus.settings.meetings.record.recording-mode.auto-start",
  none: "com.myoxus.settings.meetings.record.recording-mode.none",
} as const;

const RecordingModes: MeetingSettingsSchema["recordingMode"][] = [
  "prompt",
  "auto-start",
  "none",
];

const RecordingModeMenu = () => {
  const meetingSettingsService = useService(MeetingSettingsService);
  const settings = useLiveData(meetingSettingsService.settings$);
  const t = useI18n();

  const options = useMemo(() => {
    return RecordingModes.map((mode) => ({
      label: t[recordingModeKeys[mode]](),
      value: mode,
    }));
  }, [t]);

  const currentMode = settings.recordingMode;

  const handleRecordingModeChange = useCallback(
    (mode: MeetingSettingsSchema["recordingMode"]) => {
      meetingSettingsService.setRecordingMode(mode);
    },
    [meetingSettingsService],
  );

  return (
    <Menu
      items={options.map((option) => {
        return (
          <MenuItem
            key={option.value}
            title={option.label}
            disabled={environment.isLinux && option.value !== "none"}
            onSelect={() => handleRecordingModeChange(option.value)}
            data-selected={currentMode === option.value}
          >
            {option.label}
          </MenuItem>
        );
      })}
    >
      <MenuTrigger
        block
        disabled={environment.isLinux}
        data-myoxus-ui-role="meetings-recording-mode-trigger"
      >
        {environment.isLinux
          ? t["com.myoxus.settings.meetings.record.recording-mode.none"]()
          : options.find((option) => option.value === currentMode)?.label}
      </MenuTrigger>
    </Menu>
  );
};

interface PermissionSettingRowProps {
  name: string;
  description: string;
  permissionSetting: string;
  hasPermission: boolean;
  onOpenPermissionSetting: () => void | Promise<void>;
}

const PermissionSettingRow = ({
  name,
  description,
  permissionSetting,
  hasPermission,
  onOpenPermissionSetting,
}: PermissionSettingRowProps) => {
  const handleClick = () => {
    const result = onOpenPermissionSetting();
    if (result instanceof Promise) {
      result.catch((error) => {
        logger.error("Failed to open recording permission settings", error);
      });
    }
  };

  return (
    <SettingRow
      name={name}
      desc={
        <>
          {description}
          {!hasPermission && (
            <>
              {" "}
              <InlineActionButton onClick={handleClick}>
                {permissionSetting}
              </InlineActionButton>
            </>
          )}
        </>
      }
    >
      <IconButton
        variant={hasPermission ? "plain" : "error"}
        icon={hasPermission ? <DoneIcon /> : <InformationFillDuotoneIcon />}
        onClick={handleClick}
      />
    </SettingRow>
  );
};

export const MeetingsSettings = () => {
  const t = useI18n();
  const meetingSettingsService = useService(MeetingSettingsService);
  const desktopApiService = useService(DesktopApiService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const settings = useLiveData(meetingSettingsService.settings$);
  const [recordingFeatureAvailable, setRecordingFeatureAvailable] =
    useState(false);

  const [permissions, setPermissions] = useState<{
    screen: boolean;
    microphone: boolean;
    systemAudio: boolean;
  }>();

  useEffect(() => {
    let active = true;
    const refresh = () =>
      Promise.all([
        meetingSettingsService.isRecordingFeatureAvailable(),
        meetingSettingsService.checkMeetingPermissions(),
      ])
        .then(([available, permissions]) => {
          if (!active) return;
          setRecordingFeatureAvailable(available ?? false);
          setPermissions(permissions);
        })
        .catch((error) => {
          logger.error("Failed to check native recording availability", error);
          if (active) setRecordingFeatureAvailable(false);
        });
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [meetingSettingsService]);

  const handleEnabledChange = useEnableRecording();
  const [starting, setStarting] = useState(false);
  const [recoveries, setRecoveries] = useState<RecordingStatus[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      meetingSettingsService
        .listRecoverableRecordings()
        .then((items) => {
          if (active) setRecoveries(items);
        })
        .catch((error) =>
          logger.error("Failed to read recoverable recordings", error),
        );
    void refresh();
    const unsubscribe =
      desktopApiService.events.recording.onRecordingStatusChanged(() => {
        void refresh();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [meetingSettingsService, desktopApiService]);
  const handleStartRecording = useAsyncCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      const recording = await meetingSettingsService.startRecording();
      if (recording)
        for (const dialog of workspaceDialogService.dialogs$.value) {
          if (dialog.type === "user-settings")
            workspaceDialogService.close(dialog.id);
        }
    } finally {
      setStarting(false);
    }
  }, [meetingSettingsService, starting, workspaceDialogService]);

  const handleOpenPermissionSetting = useAsyncCallback(
    async (type: "screen" | "microphone") => {
      await meetingSettingsService.askForMeetingPermission(type);
      await meetingSettingsService.showRecordingPermissionSetting(type);
    },
    [meetingSettingsService],
  );

  const handleOpenSavedRecordings = useAsyncCallback(async () => {
    await meetingSettingsService.openSavedRecordings();
  }, [meetingSettingsService]);

  const handleRestartApp = useAsyncCallback(async () => {
    await desktopApiService.handler.ui.restartApp();
  }, [desktopApiService]);

  return (
    <Stack data-myoxus-ui-role="meetings-settings-panel">
      <SettingHeader
        title={t["com.myoxus.settings.meetings"]()}
        subtitle={t["com.myoxus.settings.meetings.setting.prompt"]()}
      />

      <EmptyState
        title={null}
        media={<ThemedImg fluid alt="" lightSrc={getArtworkUrl("meeting")} />}
        description={t["com.myoxus.settings.meetings.setting.guidance"]()}
      />
      <SettingsStatusText>
        {t["com.myoxus.settings.meetings.setting.support"]()}
      </SettingsStatusText>
      <SettingRow
        name={t["com.myoxus.settings.meetings.enable.title"]()}
        desc={t["com.myoxus.settings.meetings.enable.description"]()}
      >
        <Switch
          checked={settings.enabled}
          disabled={!recordingFeatureAvailable}
          onChange={handleEnabledChange}
          data-testid="meetings-enable-switch"
        />
      </SettingRow>

      <SettingRow
        name={t["com.myoxus.recording.start"]()}
        desc={t["com.myoxus.recording.start.description"]()}
      >
        <Button
          disabled={
            !settings.enabled ||
            !recordingFeatureAvailable ||
            !permissions ||
            !Object.values(permissions).every(Boolean) ||
            starting
          }
          loading={starting}
          onClick={handleStartRecording}
          data-testid="meetings-start-recording"
        >
          {t["com.myoxus.recording.start"]()}
        </Button>
      </SettingRow>
      {recoveries.length > 0 && (
        <SettingRow name={t["com.myoxus.recording.recoveries"]()}>
          <Menu
            items={recoveries.map((recording) => (
              <MenuItem
                key={recording.id}
                onSelect={() => {
                  void meetingSettingsService
                    .retryRecording(recording.id)
                    .catch((error) =>
                      logger.error("Failed to retry a saved recording", error),
                    );
                }}
              >
                {recording.appName ??
                  (environment.isWindows
                    ? t["com.myoxus.recording.source.microphone-system"]()
                    : t["com.myoxus.recording.source.system"]())}{" "}
                ·{" "}
                {i18nTime(recording.startTime, {
                  absolute: { accuracy: "minute" },
                })}
              </MenuItem>
            ))}
          >
            <MenuTrigger>{t["com.myoxus.recording.recoveries"]()}</MenuTrigger>
          </Menu>
        </SettingRow>
      )}

      {environment.isLinux && permissions && !permissions.systemAudio && (
        <SettingsStatusText tone="error">
          <strong>
            {t[
              "com.myoxus.settings.meetings.linux-system-audio.unavailable.title"
            ]()}
          </strong>
          {": "}
          {t[
            "com.myoxus.settings.meetings.linux-system-audio.unavailable.description"
          ]()}
        </SettingsStatusText>
      )}

      <>
        <SettingWrapper
          title={t["com.myoxus.settings.meetings.record.header"]()}
        >
          <SettingRow
            name={t["com.myoxus.settings.meetings.record.recording-mode"]()}
            desc={t[
              "com.myoxus.settings.meetings.record.recording-mode.description"
            ]()}
          >
            <RecordingModeMenu />
          </SettingRow>
          <SettingRow
            name={t["com.myoxus.settings.meetings.record.save-mode"]()}
          >
            <Menu
              items={[
                <MenuItem
                  key="new-doc"
                  onSelect={() =>
                    meetingSettingsService.setRecordingSavingMode("new-doc")
                  }
                  data-selected={settings.recordingSavingMode === "new-doc"}
                >
                  {t["com.myoxus.empty.docs.action.new-doc"]()}
                </MenuItem>,
                <MenuItem
                  key="journal-today"
                  onSelect={() =>
                    meetingSettingsService.setRecordingSavingMode(
                      "journal-today",
                    )
                  }
                  data-selected={
                    settings.recordingSavingMode === "journal-today"
                  }
                >
                  {t["com.myoxus.command-center.today-journal"]()}
                </MenuItem>,
              ]}
            >
              <MenuTrigger block>
                {settings.recordingSavingMode === "journal-today"
                  ? t["com.myoxus.command-center.today-journal"]()
                  : t["com.myoxus.empty.docs.action.new-doc"]()}
              </MenuTrigger>
            </Menu>
          </SettingRow>
          <SettingRow
            name={t["com.myoxus.settings.meetings.record.open-saved-file"]()}
            desc={t[
              "com.myoxus.settings.meetings.record.open-saved-file.description"
            ]()}
          >
            <IconButton
              icon={<ArrowRightSmallIcon />}
              onClick={handleOpenSavedRecordings}
            />
          </SettingRow>
        </SettingWrapper>
        {(environment.isMacOs || environment.isWindows) && (
          <SettingWrapper
            title={t["com.myoxus.settings.meetings.privacy.header"]()}
          >
            {environment.isMacOs && (
              <PermissionSettingRow
                name={t[
                  "com.myoxus.settings.meetings.privacy.screen-system-audio-recording"
                ]()}
                description={t[
                  "com.myoxus.settings.meetings.privacy.screen-system-audio-recording.description"
                ]()}
                permissionSetting={t[
                  "com.myoxus.settings.meetings.privacy.screen-system-audio-recording.permission-setting"
                ]()}
                hasPermission={permissions?.screen || false}
                onOpenPermissionSetting={() =>
                  handleOpenPermissionSetting("screen")
                }
              />
            )}
            <PermissionSettingRow
              name={t["com.myoxus.settings.meetings.privacy.microphone"]()}
              description={t[
                "com.myoxus.settings.meetings.privacy.microphone.description"
              ]()}
              permissionSetting={t[
                "com.myoxus.settings.meetings.privacy.microphone.permission-setting"
              ]()}
              hasPermission={permissions?.microphone || false}
              onOpenPermissionSetting={() =>
                handleOpenPermissionSetting("microphone")
              }
            />
          </SettingWrapper>
        )}

        <SettingWrapper>
          <SettingRow
            name={t["com.myoxus.settings.meetings.privacy.issues"]()}
            desc={t[
              "com.myoxus.settings.meetings.privacy.issues.description"
            ]()}
          >
            <Button onClick={handleRestartApp}>
              {t["com.myoxus.settings.meetings.privacy.issues.restart"]()}
            </Button>
          </SettingRow>
        </SettingWrapper>
      </>
    </Stack>
  );
};
