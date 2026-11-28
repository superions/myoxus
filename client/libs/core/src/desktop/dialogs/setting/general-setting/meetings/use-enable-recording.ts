// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { MeetingSettingsService } from "@myoxus/core/modules/media/services/meeting-settings";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { useCallback } from "react";

import { notify, useConfirmModal } from "../../primitives";

export const useEnableRecording = () => {
  const t = useI18n();
  const meetingSettingsService = useService(MeetingSettingsService);
  const { openConfirmModal } = useConfirmModal();

  const reportSystemAudioUnavailable = useCallback(() => {
    notify.error({
      title:
        t[
          "com.myoxus.settings.meetings.linux-system-audio.unavailable.title"
        ](),
      message:
        t[
          "com.myoxus.settings.meetings.linux-system-audio.unavailable.description"
        ](),
    });
  }, [t]);

  return useAsyncCallback(
    async (enabled: boolean) => {
      try {
        if (enabled) {
          const permissions =
            await meetingSettingsService.checkMeetingPermissions();
          if (permissions && !permissions.systemAudio) {
            reportSystemAudioUnavailable();
            return;
          }
        }
        track.$.settingsPanel.meetings.toggleMeetingFeatureFlag({
          option: enabled ? "on" : "off",
          type: "Meeting record",
        });
        await meetingSettingsService.setEnabled(enabled);
      } catch (error) {
        const permissions =
          await meetingSettingsService.checkMeetingPermissions();
        if (permissions && !permissions.systemAudio) {
          reportSystemAudioUnavailable();
          return;
        }
        const canPromptMacPermission =
          environment.isMacOs &&
          enabled &&
          !(permissions?.screen && permissions.microphone);
        if (!canPromptMacPermission) {
          notify.error({
            title: t["com.myoxus.settings.meetings"](),
            message: UserFriendlyError.fromAny(error).message,
          });
          return;
        }

        const missingMicrophoneOnly = Boolean(permissions?.screen);
        openConfirmModal({
          title: missingMicrophoneOnly
            ? t["com.myoxus.settings.meetings.privacy.microphone"]()
            : t["com.myoxus.settings.meetings.record.permission-modal.title"](),
          description: missingMicrophoneOnly
            ? t["com.myoxus.settings.meetings.privacy.microphone.description"]()
            : t[
                "com.myoxus.settings.meetings.record.permission-modal.description"
              ](),
          cancelText: t["com.myoxus.recording.dismiss"](),
          confirmText:
            t[
              "com.myoxus.settings.meetings.record.permission-modal.open-setting"
            ](),
          confirmButtonOptions: { variant: "primary" },
          onConfirm: async () => {
            await meetingSettingsService.showRecordingPermissionSetting(
              missingMicrophoneOnly ? "microphone" : "screen",
            );
          },
        });
      }
    },
    [meetingSettingsService, openConfirmModal, reportSystemAudioUnavailable, t],
  );
};
